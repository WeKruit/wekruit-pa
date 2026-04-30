---
gsd_state_version: 1.0
milestone: v1.4
milestone_name: Humanize-Runtime v2 + v1.3 Carryover (Dual Stream)
status: in_progress
last_updated: "2026-04-29T19:00:00.000Z"
last_activity: 2026-04-29
progress:
  total_phases: 12
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
---

# Milestone state

## Active milestones (dual stream, P10 strategic call 2026-04-29)

P10 cut: legacy v1.3 carryover phases 29-32 + new v1.4 humanize-runtime phases 33-40 advance **in parallel** under one execution umbrella. STATE.md `milestone: v1.4` because tooling reads single field; ROADMAP `## Phase Details (29-40)` section bundles both streams under v1.4 milestone heading so `gsd-tools roadmap analyze` discovers all 12.

### Stream A — v1.3 carryover (4 phases, infra)

P10 strategy doc: `phases/P9-AUTONOMOUS-RUN-STATUS.md` (legacy) + `MILESTONE-v1.3-PRODUCTIONIZE.md`-equivalent in ROADMAP §v1.3 table.

| # | Phase | Status | Workstream owner |
|---|-------|--------|------------------|
| 29 | Agent Handbook (Bible-as-data) | CONTEXT.md + PLAN.md exist | P9-A |
| 30 | Downstream Eval Connector | CONTEXT.md + PLAN.md exist | P9-A |
| 31 | Upstream Event Connector | CONTEXT.md + PLAN.md exist | P9-A |
| 32 | Dashboard IA Reorg + Stress Harness | CONTEXT.md exists, 4-wave swarm-ready | P9-B |

### Stream C — v1.4 humanize-runtime (8 phases, eval-first)

Canonical doc: [`MILESTONE-v1.4-humanize-runtime-v2.md`](./MILESTONE-v1.4-humanize-runtime-v2.md).

**Goal:** Push Claire's bilingual (zh+en) conversational humanness to ~70-80% Pi-level on 5 quantified metrics by attacking 4 production failure modes via deterministic detectors + ImperfectionInjector + ESConv-FSM + memory policy. Eval-first: no module work until baseline locked. 0 net new LLM calls in production path.

**Phase order:** 33 (Eval Harness Extension) → 34 (Baseline Measurement) → 35 (Detectors) → 36 (ImperfectionInjector A/B) → 37 (FSM) → 38 (Memory Policy) → 39 (External Auto Benchmarks) → 40 (Bible v7.5 + Ship).

**Estimate:** ~7.5 dev-days.

| # | Phase | Status | Workstream owner |
|---|-------|--------|------------------|
| 33 | Eval Harness Extension | COMPLETE 2026-04-29 (5 commits, 140 tests pass) | P9-C |
| 34 | Baseline Measurement | Not started | P9-C |
| 35 | 4 Deterministic Detectors | Not started | P9-C |
| 36 | ImperfectionInjector A/B | Not started | P9-C |
| 37 | FSM (5 UX × ESConv 8) | Not started | P9-C |
| 38 | Memory Policy | Not started | P9-C |
| 39 | External Auto Benchmarks | Not started | P9-C |
| 40 | Bible v7.5 + Crisis + Ship | Not started | P9-C |

### Cross-stream sync points

| Sync | Stream A | Stream C | Action |
|------|----------|----------|--------|
| S1 | Phase 29 ships handbook | Phase 40 Bible v7.5 | If 29 done first, Bible v7.5 → `pa-handbooks/claire` v2; else inline seed |
| S2 | Phase 30 downstream eval connector | Phase 33 eval harness | Different "eval" namespaces (runtime nl_judge vs offline pairwise judge) — zero file collision |
| S3 | Phase 32 Wave 3 Personas CRUD | Phase 38 memory policy | Personas seed contains current Bible voice; Phase 38 must not depend on inline strings |

## Current Position

Phase: P10 foundation work — ROADMAP renumbering + dual-stream wiring complete (this turn)
Plan: 0 of 0 (planning pending)
Status: In progress — spawning P9 agents in waves
Last activity: 2026-04-29 — milestone v1.4 spawned, P10 dual-stream topology locked, v1.4 phases renumbered 29-36 → 33-40

## Adam's blocking decisions (none currently)

All P10 strategic decisions locked:
- v1.4 D1-D16 in `MILESTONE-v1.4-humanize-runtime-v2.md`
- v1.3 carryover scope locked in legacy CONTEXT.md per phase
- Dual-stream parallel execution approved (Adam 2026-04-29 "可以同步推进吗？")

First Adam decision point: end of Phase 34 (baseline interpretation).

## Recommended execution order

**Parallel waves** (P10 spawns three P9 in parallel):

- **Wave 1 (P9-A + P9-B + P9-C parallel):**
  - P9-A: Phase 29 Handbook (Stream A foundation; downstream/upstream depend on it)
  - P9-B: Phase 32 Dashboard IA (independent, 4-wave already-spec'd)
  - P9-C: Phase 33 Eval Harness Extension (Stream C foundation; baseline depends on it)
- **Wave 2:**
  - P9-A: Phases 30 + 31 (sequential, both depend on 29 handbook + Sendblue HMAC helper)
  - P9-B: completes Phase 32 (4-wave continued)
  - P9-C: Phase 34 Baseline Measurement (gates 35-40)
- **Wave 3+:**
  - Stream C continues 35 → 36 → 37 → 38 (per quantitative gates per MILESTONE doc)
  - 39 (External Benchmarks) parallelizable with 37/38
  - 40 ships behind feature flag `PA_HUMANIZE_RUNTIME_ENABLED` after all gates pass

## Milestone goal

Quantitative voice quality improvement: 5 metrics measurably better vs rev-00056 baseline + Claire stack ≥ Qwen-72B raw on ≥1 of 5 public benchmarks (Stream C) + dashboard / handbook / connectors operator-grade (Stream A). No new LLM calls in production path. Latency stays under 12s p99.

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
- **External benchmarks verified open**: BotChat, CharacterEval, EmpatheticDialogues, ESConv, RoleLLM all 200 OK (Phase 39)
- **No prefix cache exists**: `atm-llm-runtime.ts:62` "cache" is profile credential TTL only — D7 locks adding SiliconFlow prefix cache POC

### v1.3 carryover-specific accumulated context

- **Legacy 29-32 are substantive v1.3 work**, not v1.0 leftovers (CONTEXT.md + PLAN.md already locked by P10 on 2026-04-28)
- **Phase 29 Handbook**: Firestore `pa-handbooks/{slug}` + `/versions/{v}` immutable history; orchestrator loader 30s TTL cache; dashboard editor with diff + rollback. 6 P10 success criteria locked.
- **Phase 30 Downstream Eval Connector**: post-turn fire-and-forget pipeline; regex + nl_judge conditions; HMAC-signed POST; per-(user × trigger) cooldown via Firestore composite key; master kill switch via flag `evalConnectorsEnabled`.
- **Phase 31 Upstream Event Connector**: `paInboundEvent` HTTPS CF; HMAC verify with 5-min timestamp window; Mustache-lite renderer (no loops/partials); per-(eventType × userId) rate-limit (soft 1/hr, hard 24/day); enqueue to existing `pa-outbound`.
- **Phase 32 Dashboard IA Reorg**: 4-wave parallel (IA reorg + UX P1 fixes + Playbooks/Personas CRUD + backend stress harness); converts dashboard from engineering console → operator console; new `apps/stress/` Artillery package; investigate + repair `paSendblueOutbox` last-deploy fail.

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
