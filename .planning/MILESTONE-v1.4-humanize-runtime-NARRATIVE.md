# humanize-runtime: A Cognitive Architecture Layer for Persona-Consistent Conversational Companions

**A system description (research-paper-style narrative for diagram generation)**

---

## 1. Problem Statement

We build *Claire*, a Chinese-speaking emotional-support companion that doubles as a job-search peer ("ride-or-die roommate" persona). Claire runs over iMessage and is delivered by a small open-weight backbone (Qwen2.5-7B served via SiliconFlow) plus a thin rewriter layer over a base reply model.

Despite an extensive persona prompt ("Character Bible v7.4") and a curated few-shot example bank, multi-turn dialog repeatedly exhibits four failure modes that destroy the perceived humanness of the agent:

- **F1 — Verb-phrase mirroring.** Claire echoes the user's own structural phrasing back at them, then re-uses the echoed phrase across turns ("把代码分成几部分" → "先把代码分成几部分"). Existing rule-based guards catch noun mirroring but miss verb-phrase mirroring.
- **F2 — Length escalation.** Across multi-turn vents, Claire drifts into paragraph-length, advice-laden replies, violating the persona's "≤ 1 sentence default" rule.
- **F3 — Code-switch drift.** When the user is firmly in English, Claire intermittently switches to Chinese mid-conversation, breaking immersion.
- **F4 — Self-repeat advice.** Claire repeats the same suggestion across consecutive turns under semantic paraphrasing.

These failures are not surface tics — they are symptoms of *attention decay across long-form persona prompts in small models* and of the absence of a structured cognitive layer that constrains output beyond what a system prompt can enforce. Adding more rules to the prompt does not help and can actively hurt (negative-instruction overload raises the probability of forbidden-token activation in small models). We therefore propose **humanize-runtime**, a TypeScript package that replaces the inline rewriter with a layered cognitive architecture.

---

## 2. Design Principles

The architecture is governed by four constraints, each derived directly from product context:

1. **No model escalation.** We must remain on Qwen-class open-weight models. The architecture must achieve quality gains via *structure*, not parameter count.
2. **Determinism wherever possible.** Roughly 70% of modules must contain zero LLM calls. Non-determinism is concentrated in five specific modules with explicit budgets.
3. **Vendor neutrality at the boundaries.** Memory backends (Mem0 today, possibly Letta or Zep tomorrow) and base LLM providers must be swappable behind interfaces.
4. **Eval-first.** No optimization decision is made without a measurement harness in place. The first deliverable in the milestone is the eval harness, not a feature.

---

## 3. Related Work

The architecture synthesizes ideas from six research directions, none of which alone solves the problem:

**Structured personality control.** Big5-Chat (ACL 2025) provides a 100K-dialogue corpus grounding LLM behavior in trait-anchored exemplars rather than abstract trait descriptions. We adopt the *exemplar-bank* technique, translating ~80 entries into Chinese and tagging them by both Big-Five trait dimension and target emotion state.

**Functional emotions.** EvoEmo (arXiv 2509.04310) frames LLM emotion as a Markov Decision Process and evolves transition policies via genetic algorithm in adversarial price-negotiation scenarios. We adopt the *MDP abstraction* and the discrete-state design, but operate in a single-agent companion setting and forgo the GA training pipeline (no public code; domain mismatch).

**Emotion theory base.** We anchor our state space in Plutchik's wheel of emotions (1980), an eight-dimensional model widely used in affective computing. Each user-facing UX state is defined as a vector over these eight dimensions, providing 50 years of psychological grounding for an otherwise ad-hoc taxonomy.

**Real-human idiosyncrasy injection.** Stanford's *generative agents* architecture (Park et al., NeurIPS 2024) demonstrates that grounding agents in interview-derived idiosyncrasies — not just role descriptions — produces measurably more human-like behavior. We adopt the interview protocol and idiosyncrasy-distillation pattern to populate a *texture pool* of ~250 atomic facts about real Chinese job-seekers.

**Cognitive reflection.** The Reflexion framework (Shinn et al., arXiv 2303.11366; 91% pass@1 on HumanEval vs 80% baseline GPT-4) introduces an Actor / Evaluator / Self-Reflection loop in which an LLM verbally critiques its own output, stores the critique as episodic memory, and retries with the critique as guidance. The DSPy 2.6+ `Refine` module (Stanford NLP) productionizes the same pattern as a generic N-rollout reward-driven retry loop. We port both patterns into TypeScript as a ~50-line critic loop bounded at N=2 in-turn passes.

**Companion-domain memory.** Mem0 (production-deployed) provides a personalization recall layer that we retain. Competing systems (Letta, Zep) are accessible behind a vendor-neutral `MemoryAdapter` interface; the contested LoCoMo benchmarks between vendors do not load-bear our choice.

---

## 4. Architecture Overview

The runtime executes one user turn through six sequential phases, illustrated below.

### 4.1 Three-Layer Emotion Model

The emotion subsystem is the architectural centerpiece. It is constructed as three superposed layers:

- **L1 — Theoretical base (Plutchik vector).** A struct of eight scalar intensities (joy, trust, fear, sadness, anticipation, disgust, anger, surprise), each in [0,1]. Provides external psychological validity and gives the critic a dimensional vocabulary.
- **L2 — Transition mechanism (Emotion MDP).** A finite Markov decision process whose states are user-facing UX states and whose transitions are conditioned on a categorical user signal extracted from the latest user message. Transitions carry stochastic weight; the same (state, signal) pair can yield different next-states across calls. This formalism is borrowed directly from EvoEmo, minus the genetic optimization.
- **L3 — UX expression (5-state enum).** Five named personality modes that Claire can occupy: `WarmCurious`, `PlayfulTease`, `SoftConcerned`, `FirmDirect`, `QuietWitness`. Each maps to a Plutchik vector and to a one-line directive injected into the rewriter's system prompt ("当前情绪：soft-concerned, 不要 playful").

The mapping table (initial, eval-tunable):

| UX state | joy | trust | fear | sadness | anticipation | disgust | anger | surprise |
|---|---|---|---|---|---|---|---|---|
| WarmCurious | .3 | .5 | 0 | 0 | **.8** | 0 | 0 | .2 |
| PlayfulTease | **.8** | .4 | 0 | 0 | .3 | 0 | 0 | **.5** |
| SoftConcerned | 0 | .6 | .2 | **.7** | 0 | 0 | 0 | 0 |
| FirmDirect | 0 | **.7** | 0 | 0 | .4 | .2 | .2 | 0 |
| QuietWitness | 0 | **.6** | .2 | .3 | 0 | 0 | 0 | 0 |

This three-layer construction is essential. The Plutchik vector enables critic-side scoring along orthogonal emotional dimensions without forcing the rewriter prompt to reason over eight numbers. The MDP enables auditable, eval-targetable state transitions. The five UX states give the rewriter a small, stable vocabulary that does not overload Qwen-7B's instruction-following capacity.

### 4.2 Six-Phase Per-Turn Flow

A single turn proceeds as follows:

**Phase 1 — State Assessment** (zero LLM calls).
The runtime detects the language regime of the conversation (`zh` / `en` / `mix`) via character-ratio heuristics with a lock-in policy that resists mid-conversation drift. It reads the previous emotion state from persistent storage. A rule-based `SignalAnalyzer` extracts a categorical user signal (vent / ask / celebrate / casual + intensity). The `EmotionFSM` then samples the next UX state from the MDP given (prevState, signal).

**Phase 2 — Context Assembly** (one LLM call, via Mem0).
The runtime calls `MemoryAdapter.recall` to fetch relevant user-specific facts from Mem0. It samples one or two facts from the texture pool to inject realism scaffolding. It retrieves three exemplars from the trait-and-emotion-tagged exemplar bank using BM25 / regex matching (no LLM call). All of these are assembled into a `ConversationContext` along with the emotion directive, language constraint, texture facts, and exemplars.

**Phase 3 — Generation** (two LLM calls).
The base reply model produces a draft. The Qwen rewriter then transforms the draft using the assembled context, with the emotion directive prominently injected. After the LLM call, a deterministic `StripPipeline` runs three regex-based passes — `stripRepeatOpener` (catches recycled openers), `stripValidationTic` (catches Bible-banned validation phrases like "我懂"), and `stripVerbMirror` (new — catches verb-phrase echoes from prior turns).

**Phase 4 — Reflexion-Lite Critic Loop** (one to six LLM calls; bounded at N=2 passes).
This is the architecture's main mechanism for enforcing the persona contract. We instantiate a faithful TypeScript port of Reflexion's Actor / Evaluator / Self-Reflection trio:

- The *Actor* is the rewriter from Phase 3.
- The *Evaluator* is `BibleRulesCritic`, an LLM-as-judge configured with the Bible v7.4 NEVER-rules as scoring rubric. It returns a `CriticVerdict` containing a numeric score, a binary pass/fail flag, a list of triggered violations, and a free-form hint.
- The *Self-Reflection* component takes the trajectory (failed draft + verdict) and produces a corrective hint for the next regeneration attempt.

The loop runs at most twice and exits as soon as the critic passes. The Reflexion paper's reported 91% pass@1 vs 80% baseline on HumanEval is the empirical justification for the pattern; we expect smaller absolute gains in our domain but qualitatively identical structure.

**Phase 5 — Imperfection Injection** (zero LLM calls).
A rule-based `ImperfectionInjector` selectively adds human tells — hesitation tokens ("嗯..."), self-corrections ("nvm"), soft clarification questions, or uncertainty markers ("可能吧") — driven by four policies. Each policy has explicit firing conditions (e.g., `HesitatePolicy` fires with 30% probability when the target emotion is `SoftConcerned` or `QuietWitness`). At most one imperfection token is injected per turn, respecting the Bible's stacking limit. This module has no off-the-shelf research analog; the effect is well-studied in HCI but not reduced to a public library.

**Phase 6 — Persistence** (zero foreground LLM calls).
The new emotion state is written to `EmotionStateStore`. Derived facts are written asynchronously to Mem0. The final reply text is returned to the orchestrator.

### 4.3 Module Inventory and LLM-Call Topology

The runtime exposes 17 modules, partitioned into two groups by computational cost:

- **Five LLM-call modules**: `BaseLLMPort`, `QwenRewriter`, `BibleRulesCritic`, `SelfReflection`, `MemoryAdapter` (Mem0 internal).
- **Twelve pure-logic modules**: `LanguageDetector`, `SignalAnalyzer`, `EmotionMDP`, `EmotionFSM`, `PlutchikVector`, `UXState`, `EmotionStateStore`, `TexturePool`, `ExemplarRetriever`, `StripPipeline` (×3 strips), `ImperfectionInjector` (×4 policies).

Per-turn LLM call counts:
- Best case (critic passes on first attempt): 4 calls — base draft + Qwen rewrite + critic + Mem0 recall.
- Worst case (critic fails twice): 9 calls — adds 2 critic + 2 self-reflection + 2 rewriter retries.

Latency budgets, given Qwen-7B SiliconFlow average call latency (~700 ms): best case ~3-4 s; worst case ~8-12 s. Two mitigations are designed in: (a) the critic can be served by a smaller Qwen-1.5B (~200 ms/call), reducing worst-case by ~70%; (b) the architecture forbids LLM creep into pure-logic modules — the `SignalAnalyzer` and `ExemplarRetriever` are explicitly rule-based and embedding-based respectively, never LLM-judged.

---

## 5. How Each Failure Mode Is Addressed

The architecture is organized so that each documented failure mode has a primary defense and a fallback defense:

- **F1 (Verb-phrase mirroring)** — Primary: `BibleRulesCritic` with mirror detection in scoring rubric. Fallback: `stripVerbMirror` regex pass.
- **F2 (Length escalation)** — Primary: `BibleRulesCritic` length scoring. Fallback: emotion directive in Phase 3 prompt forces concise modes for `SoftConcerned` and `QuietWitness` states.
- **F3 (Code-switch drift)** — Primary: `LanguageDetector` lock-in policy emits an explicit language constraint into `ConversationContext`. Fallback: `BibleRulesCritic` flags off-language output as violation.
- **F4 (Self-repeat advice)** — Primary: `SelfReflection` reads recent assistant turns from history; if it detects semantic redundancy, it injects an "avoid prior advice" hint into the regeneration. Fallback: emotion-state diversity (the FSM rarely re-emits the same UX state twice consecutively under identical signal, due to MDP stochasticity).

Each failure mode therefore has both a learned (LLM-judged) defense and a deterministic backstop. Neither alone is sufficient; together they offer defense in depth.

---

## 6. Evaluation Methodology

Eval is treated as the foundation, not an afterthought. The harness is built first (Sprint 1).

The eval consists of 30 hand-authored Chinese multi-turn fixtures. Each fixture specifies (a) a sequence of synthetic user turns, (b) an expected target emotion state at each turn, and (c) per-turn compliance flags. An LLM-judge (separate from the runtime's Qwen rewriter) scores each generated reply along five orthogonal metrics: emotion-transition appropriateness, Bible NEVER-rule violation count, mirror score, length compliance, and code-switch compliance. Crucially, the judge scores *transition appropriateness* rather than reply quality — quality is subjective; transitions are auditable.

The harness runs in CI, capturing baseline metrics on every PR. All optimization decisions for the trait exemplar bank, the imperfection policies, and the MDP transition table close-loop against this harness.

A second-tier eval reuses the second EvoEmo dataset (Chen et al., February 2026) — a multi-session personalized emotional support corpus — as out-of-distribution validation, to guard against fixture overfitting.

---

## 7. Package Boundaries and Reuse

The runtime ships as `@pa/humanize-runtime`, a TypeScript package in our existing monorepo. It depends on three internal packages — `@pa/agent-runtime` (base LLM provider, wraps OpenAI agent), `@pa/memory` (Mem0 client), and `@pa/agent-registry` (Bible and few-shot bank) — and is consumed by `@pa/pa-orchestrator`, which retires its inline rewriter and strip code in the same change.

The package is intentionally companion-shaped, not WeKruit-PA-specific. A future companion product (different persona, different domain) can import the same runtime, swap in its own Bible and trait profile, and inherit the entire emotion-FSM, critic loop, and imperfection layer for free.

---

## 8. What This Architecture Is Not

To prevent ambiguity in technical review:

- It is **not** an autonomous agent framework. There is no tool-calling, no MCP, no planner. A turn in equals a reply out.
- It is **not** a fine-tuning pipeline. We do not train weights. All persona conditioning is via prompts, exemplars, and structured context.
- It is **not** a graph-based orchestrator (we explicitly chose not to use LangGraph or similar). The runtime is a six-phase pipeline; each phase is a TypeScript function with explicit dependencies, debuggable as ordinary code.
- It is **not** Reflexion or DSPy used as a library. We port the relevant patterns into TypeScript to remain in our monorepo and avoid a Python boundary.
- It is **not** a memory system. Memory is a dependency (Mem0 today), not a contribution.

---

## 9. Open Questions and Future Work

Four questions remain open at the time of this document:

- The optimal model size for the critic (Qwen-1.5B vs Qwen-7B) — to be determined empirically once Sprint 4 lands.
- Recruitment plan and IRB-equivalent ethical handling for the eight real-user interviews underpinning the texture pool.
- Translation methodology for Big5-Chat exemplars (LLM with human review vs full human translation).
- The naming and gradual-rollout schedule for the production feature flag.

Future work, post-MVP:

- Automated tuning of the Plutchik mapping table via the eval harness (treating the table as 40 free parameters and searching for the configuration that maximizes transition-appropriateness on held-out fixtures).
- Online learning of the MDP transition probabilities from production usage logs, conditional on user-feedback signals.
- Replacement of the rule-based `SignalAnalyzer` with a small distilled classifier if rule coverage proves insufficient.

---

## 10. References

[1] Shinn, N., et al. (2023). *Reflexion: Language Agents with Verbal Reinforcement Learning*. NeurIPS 2023. arXiv:2303.11366. https://github.com/noahshinn/reflexion

[2] Long, X., et al. (2025). *EvoEmo: Towards Evolved Emotional Policies for Adversarial LLM Agents in Multi-Turn Price Negotiation*. arXiv:2509.04310. https://arxiv.org/abs/2509.04310

[3] Liu, J., et al. (2025). *Big5-Chat: Shaping LLM Personalities Through Training on Human-Grounded Data*. ACL 2025. https://aclanthology.org/2025.acl-long.999.pdf

[4] DPRF (2025). *Dynamic Persona Refinement Framework*. arXiv:2510.14205. https://arxiv.org/html/2510.14205

[5] Park, J. S., et al. (2024). *Generative Agent Simulations of 1,000 People*. NeurIPS 2024. arXiv:2411.10109. https://github.com/joonspk-research/genagents

[6] Plutchik, R. (1980). *A general psychoevolutionary theory of emotion*. In Theories of Emotion (pp. 3-33). Academic Press.

[7] DSPy: *Refine and BestOfN modules*. Stanford NLP. https://dspy.ai/api/modules/Refine/

[8] Mem0 (2025). *Building Production-Ready AI Agents with Scalable Long-Term Memory*. arXiv:2504.19413. https://mem0.ai/research

[9] Kadavath, S., et al. (2022). *Language Models (Mostly) Know What They Know*. Anthropic. (Calibrated uncertainty foundation for ImperfectionInjector design.)
