---
gsd_state_version: 1.0
milestone: v1.4
milestone_name: Humanize-Runtime v2 + v1.3 Carryover (Dual Stream)
status: in_progress
last_updated: "2026-04-30T03:00:00.000Z"
last_activity: 2026-04-30
progress:
  total_phases: 12
  completed_phases: 10
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
| 29 | Agent Handbook (Bible-as-data) | ✅ COMPLETE 2026-04-29 (T1-T4, 4 commits + handbook integration tests 7/7 pass; SDK 18/18 + orch 201/201 pass) | P9-A |
| 30 | Downstream Eval Connector | ✅ COMPLETE 2026-04-29 (T1-T3 prior + T-Wrap-1/2/3 P9-A Wave 2: master kill switch `evalConnectorsEnabled` + nano default nl-judge + 2 default disabled triggers seeded (mentioned_layoff, mentioned_salary_research) + SEED.md + FIRESTORE-TTL.md; pa-orchestrator 213/213 pass; pa-persistence 91/91 pass; typecheck clean) | P9-A |
| 31 | Upstream Event Connector | ✅ COMPLETE 2026-04-29 (T1-T3, 3 commits; paUpstreamEventWebhook CF + HMAC + Mustache-lite renderer + dashboard page) | P9-A |
| 32 | Dashboard IA Reorg + Stress Harness + Playbooks/Personas CRUD | ✅ COMPLETE 2026-04-29 (W1-W4, 8 wave commits + 3 deploy-fix; sidebar 5-cat, Conversations row redesign, UserDetail OperatorSummary, Voice split, Flags drawer, Playbooks+Personas Firestore CRUD, Artillery harness, paSendblueOutbox repaired, cloud-logging dashboard.json; agent-registry 33/33, pa-orchestrator 201/201, typecheck clean) | P9-B |

### Stream C — v1.4 humanize-runtime (8 phases, eval-first)

Canonical doc: [`MILESTONE-v1.4-humanize-runtime-v2.md`](./MILESTONE-v1.4-humanize-runtime-v2.md).

**Goal:** Push Claire's bilingual (zh+en) conversational humanness to ~70-80% Pi-level on 5 quantified metrics by attacking 4 production failure modes via deterministic detectors + ImperfectionInjector + ESConv-FSM + memory policy. Eval-first: no module work until baseline locked. 0 net new LLM calls in production path.

**Phase order:** 33 (Eval Harness Extension) → 34 (Baseline Measurement) → 35 (Detectors) → 36 (ImperfectionInjector A/B) → 37 (FSM) → 38 (Memory Policy) → 39 (External Auto Benchmarks) → 40 (Bible v7.5 + Ship).

**Estimate:** ~7.5 dev-days.

| # | Phase | Status | Workstream owner |
|---|-------|--------|------------------|
| 33 | Eval Harness Extension | COMPLETE 2026-04-29 (5 commits, 140 tests pass) | P9-C |
| 34 | Baseline Measurement | ✅ COMPLETE 2026-04-29 (deterministic-only baseline, 155 turns; baseline-rev00056.md locked + per-Phase gates 35-40; judge + embed deferred Adam-approval) | P10 main |
| 35 | 4 Deterministic Detectors | ✅ PARTIAL 2026-04-29 (T1-T5, 6 commits; F1/F2/F3/F4 + framework + smoke harness; 67/67 tests pass; F1 recall 100% on Phase 34 known-fails, F1/F2/F3 false-positive 0% on smoke; F4 graceful degrade verified; latency p95 < 250ms total. **Wire-in deferred** — Adam applies `WIRE-IN-PATCH.md` after committing pending llm-rewriter.ts work) | P9-C |
| 36 | ImperfectionInjector A/B | ✅ PARTIAL 2026-04-30 (T1-T5, 5 commits + docs commit; injector module + 3-arm router + position constraint + bilingual policies + A/B harness + 2 scenarios; 89/89 tests pass; 0 FILLER_BLACKLIST collisions; arm probability ±3pp; latency p95 < 5ms; A/B harness `--dry-run` plans 18 reply + 12 judge calls. **Wire-in deferred** — Adam applies `WIRE-IN-PATCH.md` after Phase 35 wire-in + needs to approve $0.50-$2 LLM budget for live A/B run) | P9-C |
| 37 | FSM (5 UX × ESConv 8) | ✅ PARTIAL 2026-04-30 (T1-T4, 5 commits incl docs; FSM module + 5-class rule-based ux classifier + per-uxState transitions + Phase 33 parity audit + 50 hand-labeled bilingual fixtures + accuracy gate; 99/99 tests pass; ux_state classifier accuracy 98% (49/50, gate ≥70%); strategy_fit allowed-set 100% on synthetic-aligned (50/50); inferStrategy match expected 100%; runFsm latency p95 < 10ms. **Wire-in deferred** — Adam applies `WIRE-IN-PATCH.md` after Phase 35 + 36 wire-ins land + own pending llm-rewriter.ts work committed) | P9-C |
| 38 | Memory Policy | ✅ PARTIAL 2026-04-30 (T1-T4, 5 commits incl docs; memory-policy module + advice-tracker SDK + Firestore `pa-advice-tracker/{userId}/items/{turnId}` + BGE-M3 cos-sim repeat detector + 10 contradiction fixtures + S3 sync via `getPersona` Firestore + extractor pinning audit Qwen-7B+ tier + bilingual prompt-injector + 50-turn synthetic detection-rate gate + WIRE-IN-PATCH; 87/87 tests pass; contradiction recall 10/10 on positive fixtures (gate ≥9/10); negative false-positive 0/5 (gate ≤1/5); S3 sync verified (Type 10 reads `pa-personas/{slug}` Firestore not inline); extractor audit rejects 1.5B/0.5B/0.6B/mini/tiny/small + soft-warn default; runMemoryPolicy latency p95 < 200ms over 50 invocations; tight-repeat 50-turn detection rate ≥ 90% on synthetic; 0 net new LLM calls in production path. **Wire-in deferred** — Adam applies `WIRE-IN-PATCH.md` after Phase 35/36/37 wire-ins land + own pending llm-rewriter.ts work committed) | P9-C |
| 39 | External Auto Benchmarks | Not started | P9-C |
| 40 | Bible v7.5 + Crisis + Ship | Not started | P9-C |

### Cross-stream sync points

| Sync | Stream A | Stream C | Action |
|------|----------|----------|--------|
| S1 | Phase 29 ships handbook | Phase 40 Bible v7.5 | If 29 done first, Bible v7.5 → `pa-handbooks/claire` v2; else inline seed |
| S2 | Phase 30 downstream eval connector | Phase 33 eval harness | Different "eval" namespaces (runtime nl_judge vs offline pairwise judge) — zero file collision |
| S3 | Phase 32 Wave 3 Personas CRUD | Phase 38 memory policy | Personas seed contains current Bible voice; Phase 38 must not depend on inline strings |

## Current Position

Phase: Stream A v1.3 carryover ✅ COMPLETE (29 + 30 + 31 + 32). Stream C v1.4 in progress — Phases 33 + 34 ✅ COMPLETE; Phase 35 ✅ PARTIAL (detectors built, wire-in Adam-owed); Phase 36 ✅ PARTIAL (injector + A/B harness built, wire-in Adam-owed); Phase 37 ✅ PARTIAL (FSM built, wire-in Adam-owed); Phase 38 ✅ PARTIAL (Memory Policy built, wire-in Adam-owed).
Plan: Stream A done (4/4 phases shipped); Stream C 6/8 (Phases 33 + 34 + 35-partial + 36-partial + 37-partial + 38-partial; 2 remaining: 39 External Benchmarks + 40 Bible v7.5 + Ship)
Status: Stream A wrapped — operator-grade dashboard + connectors + handbook live; Stream C — F1/F2/F3/F4 detector module + ImperfectionInjector + 3-arm A/B harness + FSM (5 UX × ESConv 8) module + Memory Policy (advice tracker + contradiction detector + extractor pinning) shipped behind feature flags `PA_DETECTORS_ENABLED`, `PA_IMPERFECTION_INJECTOR_ENABLED`, `PA_FSM_ENABLED`, and `PA_MEMORY_POLICY_ENABLED` (default off); Adam-owed P0 tasks: apply 4 WIRE-IN-PATCH.md files in order (35 → 36 → 37 → 38) after committing pending uncommitted work + approving $0.50-$2 LLM budget for live A/B run + verify Firestore composite index for `pa-advice-tracker`
Last activity: 2026-04-30 — Phase 38 T1-T4 complete (P9-C); 87/87 memory-policy tests pass; contradiction recall 10/10 on positive fixtures (gate ≥9/10); negative false-positive 0/5 (gate ≤1/5); S3 sync verified — Type 10 reads `pa-personas/{slug}` Firestore via `getPersona` (NOT inline strings); extractor pinning rejects 1.5B/0.5B/0.6B/mini/tiny/small with soft-warn default; runMemoryPolicy latency p95 < 200ms; tight-repeat 50-turn detection rate ≥ 90% on synthetic; bilingual zh+en+mixed coverage in fixtures + tests; 0 net new LLM calls in production path

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
