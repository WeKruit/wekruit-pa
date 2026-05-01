# Milestone v1.4 — `humanize-runtime` Package (Cognitive Architecture for Companion Voice)

**Status:** Plan (P10 architecture locked, awaiting Sprint 0 greenlight)
**Spawned:** 2026-04-29
**Predecessor:** v1.3 (Productionize gate + Self-Evolve loop)
**Successor:** v1.5 (TBD — likely TexturePool real-user interview ramp)

---

## Why This Milestone

v1.2/v1.3 stabilized voice via Bible v7.x + few-shot bank + strip pipeline (`stripRepeatOpener`, `stripValidationTic`). Reduced opener-tic + 我懂 tic to 0 in sim audit (rev 00056). **But residual failure modes remain**:

1. **Verb-phrase mirror** — Claire echoes user's noun/verb structure (dashboard 2026-04-29: T6 "把代码分成几部分" → T8 "先把代码分成几部分"). Bible 7b (`NEVER MIRROR-PHRASE`) only catches noun mirroring.
2. **Length escalation** — `formal_em` persona produces paragraph replies, violating Bible "≤1 sentence default".
3. **Code-switch drift** — `en_grad` persona switches to Chinese mid-conversation (sim T20).
4. **Self-repeat advice** — same suggestion across turns ("先把代码分成几部分" appears T6 + T8).

Root cause: these are **prompt/cognitive-level** failures, not strip-level. Bible alone can't enforce them on Qwen-7B. Strip pipeline catches deterministic patterns but not semantic mirroring or length.

**Strategic shift:** stop bolting on more strip rules. Build a proper **cognitive architecture layer** — emotion state machine + reflection critic + imperfection injection — packaged as a reusable runtime (`@pa/humanize-runtime`).

Aligns with research consensus (2025-26): persona consistency is achieved via **structured cognitive layers**, not via larger system prompts. See research synthesis below.

---

## Research Foundation (2025-26 academic backing)

| Concept | Paper / Repo | What we borrow |
|---|---|---|
| Structured personality | [Big5-Chat (ACL 2025)](https://aclanthology.org/2025.acl-long.999.pdf) + [DPRF (arXiv 2510.14205)](https://arxiv.org/html/2510.14205) | Trait-anchored exemplar bank (~80 translated dialogues) |
| Functional emotions | [EvoEmo (arXiv 2509.04310)](https://arxiv.org/abs/2509.04310) — 7-state MDP, GA-evolved policies | MDP abstraction + state-transition formalism (skip the GA training) |
| Emotion theory base | Plutchik wheel (1980), 8 base emotions × intensity | Theoretical anchor for 5-state UX layer |
| Real-human texture | [Stanford genagents (NeurIPS 2024)](https://github.com/joonspk-research/genagents) — 1052 interview-grounded agents | Interview protocol + idiosyncrasy distillation pattern |
| Cognitive reflection | [Reflexion (arXiv 2303.11366, 91% HumanEval)](https://arxiv.org/abs/2303.11366) + [DSPy Refine](https://dspy.ai/api/modules/Refine/) | Actor + Evaluator + Self-Reflection loop, ~50 LoC TS port |
| Imperfection / hesitation | Calibrated Uncertainty Prompting (Kadavath 2022); no off-shelf for our domain | Self-built `ImperfectionInjector` w/ rule-based policies |
| Memory | Mem0 (existing in stack) | Vendor-neutral `MemoryAdapter` interface (Letta/Zep swap-ready) |

**LoCoMo benchmark dispute (Mem0 vs Zep):** noted but not load-bearing. We don't pick winner; we abstract via interface. ([Zep blog](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/), [Mem0 paper](https://arxiv.org/html/2504.19413v1))

---

## Package Architecture

### Package: `@pa/humanize-runtime`

**Position:** business layer (not infrastructure). Depends on `@pa/agent-runtime` (base LLM provider), `@pa/memory` (Mem0), `@pa/agent-registry` (Bible/persona docs). Consumed by `@pa/pa-orchestrator`.

```
@pa/companion-runtime  ← reused by future companion products
        ├─ depends ▶ @pa/core-types
        ├─ depends ▶ @pa/agent-runtime    (BaseLLMPort impl)
        ├─ depends ▶ @pa/memory           (Mem0 adapter wrap)
        └─ depends ▶ @pa/agent-registry   (Bible/persona)

@pa/pa-orchestrator
        └─ depends ▶ @pa/humanize-runtime  ★ replaces inline rewriter+strip
```

### Three-layer Emotion Model

| Layer | Component | Purpose |
|---|---|---|
| **L1 Theory base** | `PlutchikVector` (8 dims, 0-1 intensity) | Theoretical grounding (50yr psychology). Every UX state maps to a vector. |
| **L2 Transition mech** | `EmotionMDP` | Markov state-transition table (EvoEmo-style, no GA — hand-tuned v0, eval-driven later) |
| **L3 UX expression** | `UXState` (5 enum) | Claire's actual personalities: `WarmCurious`, `PlayfulTease`, `SoftConcerned`, `FirmDirect`, `QuietWitness` |

**Mapping table** (Plutchik → UX):

| UX state | joy | trust | fear | sadness | anticipation | disgust | anger | surprise |
|---|---|---|---|---|---|---|---|---|
| WarmCurious | .3 | .5 | 0 | 0 | **.8** | 0 | 0 | .2 |
| PlayfulTease | **.8** | .4 | 0 | 0 | .3 | 0 | 0 | **.5** |
| SoftConcerned | 0 | .6 | .2 | **.7** | 0 | 0 | 0 | 0 |
| FirmDirect | 0 | **.7** | 0 | 0 | .4 | .2 | .2 | 0 |
| QuietWitness | 0 | **.6** | .2 | .3 | 0 | 0 | 0 | 0 |

(v0 anchors; tuned via eval harness in Sprint 1.)

### Module Inventory (17 modules)

```
packages/humanize-runtime/src/
├── runtime/
│   ├── CompanionRuntime.ts          ★ facade — single entry point
│   └── ConversationContext.ts
├── emotion/                         ★① three-layer emotion
│   ├── PlutchikVector.ts              L1
│   ├── PlutchikMapping.ts             L1↔L3 table
│   ├── EmotionMDP.ts                  L2 transitions
│   ├── UXState.ts                     L3 enum
│   ├── EmotionFSM.ts                  facade (next + toDirective)
│   └── SignalAnalyzer.ts              user msg → UserSignal (rule-based)
├── persona/
│   ├── PersonaRegistry.ts             loads Bible v7.4
│   ├── TraitProfile.ts                Big5 vector
│   ├── ExemplarBank.ts                ★② trait+emotion tagged
│   └── ExemplarRetriever.ts           BM25/regex (NO LLM)
├── language/
│   ├── LangState.ts
│   └── LanguageDetector.ts            char-ratio + lock-in policy
├── memory/
│   ├── MemoryAdapter.ts               «interface»
│   ├── Mem0Adapter.ts                 concrete
│   ├── EmotionStateStore.ts           «interface» (split from MemoryAdapter)
│   ├── FirestoreEmotionStore.ts       concrete
│   └── TexturePool.ts                 ★③ 250 zh interview-distilled facts
├── rewriter/
│   ├── RewriterPipeline.ts
│   ├── QwenRewriter.ts                SiliconFlow client
│   ├── StripPipeline.ts
│   └── strips/
│       ├── stripRepeatOpener.ts       (port from voice/llm-rewriter.ts)
│       ├── stripValidationTic.ts      (port)
│       └── stripVerbMirror.ts         ★ NEW
├── critic/                          ★④ Reflexion-lite (Actor/Evaluator/M_sr trio)
│   ├── CriticLoop.ts                  N=2 sync loop
│   ├── Critic.ts                      «interface»
│   ├── BibleRulesCritic.ts            Evaluator — scores against Bible NEVER-rules
│   ├── SelfReflection.ts              M_sr — trajectory → hint
│   ├── CriticVerdict.ts               {score, pass, violations, hint}
│   └── Trajectory.ts                  bounded N=2 in-turn memory
├── imperfection/                    ★ Part B (no off-shelf, self-built)
│   ├── ImperfectionInjector.ts
│   ├── ImperfectionPolicy.ts          «interface»
│   └── policies/
│       ├── HesitatePolicy.ts          "嗯..." / "wait" / "我想想"
│       ├── SelfCorrectPolicy.ts       "nvm" / "算了"
│       ├── ClarifyPolicy.ts           soft 反问 (NOT probe)
│       └── UncertaintyPolicy.ts       "可能吧" / "我也不知道"
├── eval/                            ★ measurement first
│   ├── FixtureRunner.ts               runs 30 zh-CN multi-turn fixtures
│   ├── LLMJudge.ts                    transition + Bible scorer
│   ├── Fixture.ts
│   └── metrics/
│       ├── EmotionTransitionMetric.ts
│       ├── BibleViolationMetric.ts
│       ├── MirrorMetric.ts
│       ├── LengthMetric.ts
│       └── CodeSwitchMetric.ts
└── ports/
    ├── BaseLLMPort.ts                 «interface» — agent-runtime wraps
    ├── ClockPort.ts
    └── LoggerPort.ts
```

---

## LLM Call Audit (per turn)

**5 modules invoke LLM** (in or via):

| # | Module | Calls/turn | Model | Notes |
|---|---|---|---|---|
| 1 | `BaseLLMPort.draft` | 1 | OpenAI agent (current base) | Generate raw reply |
| 2 | `QwenRewriter.rewrite` | 1 (+1-2 retries) | Qwen2.5-7B (SiliconFlow) | Voice rewrite + on critic fail |
| 3 | `BibleRulesCritic.score` | 1-2 (per N pass) | **TBD: Qwen-1.5B preferred** | NEVER-rules scorer |
| 4 | `SelfReflection.reflect` | 0-2 (only on fail) | Qwen-7B | Trajectory → hint |
| 5 | `MemoryAdapter` (Mem0 internal) | ~1 (recall) + ~1 (write, async) | OpenAI embedding + extractor | Mem0 SDK call |

**Per-turn LLM call count:**
- **Best case** (critic passes first time): 1 (base) + 1 (qwen) + 1 (critic) + 1 (Mem0 recall) = **4 calls**
- **Worst case** (N=2 critic fails twice): 1 + 1 + 2 (critic) + 2 (M_sr) + 2 (qwen retry) + 1 (Mem0) = **9 calls**

**Latency budget:**
- Best ~3-4s (Qwen-7B SiliconFlow ~700ms/call avg)
- Worst ~8-12s — **risk: user-perceived "thinking" pause**

**Mitigation strategies:**
1. Use **Qwen-1.5B** for critic (~200ms/call) — cuts critic+SR contribution by 70%
2. **SignalAnalyzer / ExemplarRetriever stay LLM-free** (rule-based) — must not regress to LLM
3. Optional: critic async (don't block) — but breaks reflexion loop. Default: sync.

**12 modules are LLM-free** (pure deterministic logic):
LanguageDetector, SignalAnalyzer, EmotionMDP, EmotionFSM, PlutchikVector, UXState, EmotionStateStore (Firestore I/O), TexturePool.sample, ExemplarRetriever, StripPipeline (×3), ImperfectionInjector (×4 policies)

→ **70% of modules zero LLM calls** = unit-testable, zero latency, zero $/turn. Determinism backstop for non-determinism.

---

## Per-turn Data Flow

```
TurnInput
   │
   ▼ Phase 1 — State Assessment (NO LLM)
   ├─ LanguageDetector.detect(history)         → langState
   ├─ EmotionStateStore.read(sessionId)        → prevState
   ├─ SignalAnalyzer.analyze(userText)         → UserSignal
   └─ EmotionFSM.next(prevState, signal)       → targetState
   │
   ▼ Phase 2 — Context Assembly (1 LLM via Mem0)
   ├─ MemoryAdapter.recall(userId, userText, k=5)
   ├─ TexturePool.sample(k=2)
   ├─ ExemplarRetriever.retrieve(trait, targetState, k=3)
   └─ assemble ConversationContext
        + emotionDirective (1-line from FSM)
        + langConstraint
        + textureFacts
        + exemplars
   │
   ▼ Phase 3 — Generation (2 LLM)
   ├─ BaseLLMPort.draft(ctx)                   → draftReply
   └─ RewriterPipeline.rewrite(draft, ctx)     → rewritten
        ├─ QwenRewriter.rewrite (with directive)
        └─ StripPipeline (regex backstop)
   │
   ▼ Phase 4 — Reflexion-lite Critic Loop (1-6 LLM, ≤ N=2 passes)
   for i in 0..N:
     ├─ BibleRulesCritic.score(text, ctx)      → CriticVerdict
     ├─ if PASS: break
     └─ else:
         ├─ SelfReflection.reflect(trajectory) → hint
         └─ RewriterPipeline.rewrite(text, ctx + hint)
   │
   ▼ Phase 5 — Imperfection Injection (NO LLM)
   └─ ImperfectionInjector.inject(final, ctx)
        ├─ HesitatePolicy / SelfCorrectPolicy
        ├─ ClarifyPolicy / UncertaintyPolicy
        └─ ≤1 imperfection token / turn (Bible cap)
   │
   ▼ Phase 6 — Persistence (NO LLM in foreground)
   ├─ EmotionStateStore.write(sessionId, targetState)
   └─ MemoryAdapter.write(userId, derivedFacts) [async, ~1 LLM bg]
   │
   ▼ TurnOutput {replyText, emotionStateAfter, criticPasses, traceMeta}
```

---

## Key Interfaces (DI ports)

```ts
// ports/BaseLLMPort.ts — implemented by @pa/agent-runtime
export interface BaseLLMPort {
  draft(ctx: ConversationContext): Promise<string>
}

// memory/MemoryAdapter.ts — vendor-neutral
export interface MemoryAdapter {
  recall(userId: string, query: string, k: number): Promise<MemoryHit[]>
  write(userId: string, fact: MemoryFact): Promise<void>
}

// memory/EmotionStateStore.ts — split from MemoryAdapter (decision #5)
export interface EmotionStateStore {
  read(sessionId: string): Promise<UXState | null>
  write(sessionId: string, state: UXState): Promise<void>
}

// critic/Critic.ts
export interface Critic {
  score(text: string, ctx: ConversationContext): Promise<CriticVerdict>
}

// imperfection/ImperfectionPolicy.ts
export interface ImperfectionPolicy {
  shouldFire(ctx: ConversationContext): boolean
  apply(text: string): string
}
```

---

## Sprint Roadmap

| Sprint | Days | Deliverable | Dependency |
|---|---|---|---|
| **0** | 1 | Package scaffold + all `«interface»` + types | — |
| **1** | 2 | Eval harness (FixtureRunner + LLMJudge + 5 metrics) + 30 zh-CN fixtures | Sprint 0 |
| **2** | 1 | EmotionFSM (PlutchikVector + Mapping + MDP v0 + UXState) | Sprint 0 |
| **3** | 3 | ExemplarBank v2 + Big5-Chat 80 translated entries | Sprint 1 |
| **4** | 2 | CriticLoop (Reflexion-lite TS port) + BibleRulesCritic + SelfReflection | Sprint 0, 1 |
| **5** | 1 | ImperfectionInjector + 4 policies | Sprint 0 |
| **6** | 1 | stripVerbMirror + LanguageDetector | Sprint 0 |
| **7** | 3 | Mem0Adapter + EmotionStateStore (Firestore impl) | Sprint 0 |
| **8** | 2 | CompanionRuntime facade — wires all modules | Sprint 1-7 |
| **9** | 2 | pa-orchestrator integration + feature-flag gradual rollout | Sprint 8 |
| **10** (parallel) | 14 | TexturePool — 8 real-user interviews + distillation (recruitment-blocked) | independent |

**Total MVP (without TexturePool):** ~18 working days (~4 weeks)
**Full milestone (with TexturePool):** ~6 weeks

---

## Decisions Locked (P10 ratified 2026-04-29)

| # | Decision | Choice |
|---|---|---|
| 1 | Package name | `@pa/humanize-runtime` (English-correct spelling, user typo `humanlize` corrected) |
| 2 | MemoryAdapter abstraction | Interface-based (Letta/Zep swap-ready) |
| 3 | Critic loop sync vs async | **Sync** (first-reply quality > latency) |
| 4 | Eval fixture count v0 | 30 zh-CN multi-turn |
| 5 | EmotionStateStore abstraction | Separate interface (decoupled from MemoryAdapter) |
| 6 | Old `voice/llm-rewriter.ts` | Keep deprecated during migration; remove after Sprint 9 ships |
| 7 | Emotion model granularity | 3-layer: Plutchik 8 + UXState 5 + EvoEmo MDP |
| 8 | Reflexion port | TS reimplementation (~50 LoC), not library import |
| 9 | Imperfection layer | Self-built (no off-shelf), rule-based policies |

---

## Out of Scope (explicit non-goals)

- **NO LangGraph** (user explicit constraint)
- **NO model escalation** (Adam refuses bigger LLMs — use Qwen-7B / Qwen-1.5B class only)
- **NO Zep / Letta migration** (Mem0 stays; interface enables future swap if data shows ROI)
- **NO DSPy library import** (Python; reimplement Refine pattern in TS)
- **NO genagents library import** (use protocol + architecture pattern; not the Python framework)
- **NO EvoEmo GA training** (no public code; borrow MDP abstraction only)
- **NO real-user TexturePool in MVP** (Sprint 10 is parallel; MVP ships without it)

---

## Success Criteria

**MVP (post-Sprint 9):**
- [ ] All 17 modules unit-tested (90%+ coverage on pure-logic modules)
- [ ] 30 fixture eval harness runs in CI; baseline metrics captured
- [ ] dashboard sim audit: 0 verb-mirror, 0 length-overflow, 0 code-switch drift across 5 personas × 12 turns
- [ ] Per-turn p95 latency ≤ 5s (best case path)
- [ ] Per-turn p99 latency ≤ 12s (worst case path)
- [ ] pa-orchestrator integration behind feature flag, gradual rollout (10% → 50% → 100%)
- [ ] Old `voice/llm-rewriter.ts` deprecated, scheduled for removal

**Full milestone (post-Sprint 10):**
- [ ] TexturePool populated with 250+ distilled facts from 8 real interviews
- [ ] Trait-anchored exemplar bank measurably outperforms current scenario-anchored bank on transition-appropriateness eval

---

## Open Questions (need answer before Sprint 0)

1. **Critic model choice:** Qwen-1.5B (latency) vs Qwen-7B (quality)? Default: 1.5B; revisit if eval shows quality regression.
2. **TexturePool recruitment:** Adam recruits or external? Affects Sprint 10 start date.
3. **Big5-Chat translation:** human or LLM? Recommend LLM-translate + human-review on 20% sample.
4. **Feature flag name:** `PA_HUMANIZE_RUNTIME_ENABLED` (suggest)?

---

## Cross-References

- v1.2 Bible v7.x foundation: [`MILESTONE-v1.2.md`](./MILESTONE-v1.2.md)
- Current voice baseline (rev 00056): `packages/pa-orchestrator/src/voice/llm-rewriter.ts` (to be deprecated)
- Sim audit script: `/private/tmp/sim-audit-rev56.mjs`
- Source rewriter pipeline: `packages/pa-orchestrator/src/index.ts:processInboundEvent`
- Existing agent-runtime: `packages/agent-runtime/src/`
- Existing memory layer: `packages/memory/src/`
