# Cross-Validation & Feasibility Research Prompt for `humanize-runtime`

**Use:** Paste this entire document into a Deep Research tool (ChatGPT Deep Research, Gemini Deep Research, Perplexity Pro, You.com, or a multi-step research agent). It is self-contained — the research tool does not need any other context from us.

**Goal:** Stress-test our proposed architecture against the open-source / academic / industry literature. Find weaknesses, contradicting evidence, missing prior work, and stronger alternatives BEFORE we commit ~4 weeks of engineering.

---

## 1. Background — what we're building

We are building **`humanize-runtime`**, a TypeScript package that produces persona-consistent, emotionally appropriate replies from a small open-weight LLM (Qwen2.5-7B served via SiliconFlow) for a Chinese-speaking emotional-support + job-search companion product called *Claire*. Claire runs over iMessage and is a "ride-or-die roommate" persona — short, slangy, fragmentary, never coach-y or therapist-y, never AI-sounding.

We have already shipped a "Character Bible v7.4" prompt + few-shot bank + deterministic strip pipeline (regex-based opener-repeat removal, banned-phrase removal). That shipped in milestones v1.2 / v1.3. **It works for opener-repetition and banned phrases but fails on four remaining failure modes** (see §3). We now propose a deeper architectural layer to fix these.

**Hard constraints we cannot change:**
- No model escalation (must stay Qwen-7B class; 1.5B for cheap calls)
- No LangGraph / no heavyweight Python orchestration framework
- TypeScript / Node / Firebase Cloud Functions stack
- Mem0 already in production for memory; vendor-neutral interface preferred
- Total per-turn latency must remain < ~12s p99
- Open-source-friendly only (no proprietary frameworks we can't run)

---

## 2. Proposed architecture (the thing under review)

### 2.1 Package structure

`@pa/humanize-runtime` = single TypeScript package, 17 modules, 6-phase per-turn pipeline.

### 2.2 The six phases of one user turn

**Phase 1 — State Assessment (zero LLM calls):**
- `LanguageDetector`: char-ratio heuristic + lock-in policy → `LangState ∈ {zh, en, mix}`
- `SignalAnalyzer`: keyword + regex on user message → `UserSignal {sentiment, intent, intensity}`
- `EmotionStateStore.read`: previous turn's UX state from Firestore
- `EmotionFSM.next(prevState, signal)`: samples next UX state from a Markov decision process

**Phase 2 — Context Assembly (1 LLM call via Mem0 internals):**
- `MemoryAdapter.recall`: fetches user-specific memories via Mem0
- `TexturePool.sample`: 1-2 random "human texture" facts from a curated pool of ~250 idiosyncrasies distilled from real-user interviews
- `ExemplarRetriever`: retrieves 3 few-shot exemplars by `(trait, emotionState)` tag using BM25/regex (NOT embedding similarity — pure deterministic)
- Assembles a `ConversationContext` object with `emotionDirective` (one-line string), `langConstraint`, exemplars, memory hits, texture facts

**Phase 3 — Generation (2 LLM calls):**
- Base reply LLM produces a draft
- Qwen2.5-7B rewriter rewrites the draft conditioned on the full ConversationContext (including the emotion directive injected as a single prompt line)
- Deterministic `StripPipeline`: three regex passes — `stripRepeatOpener`, `stripValidationTic` (banned phrases), `stripVerbMirror` (NEW)

**Phase 4 — Reflexion-lite Critic Loop (1-6 LLM calls; bounded N=2):**
- TypeScript port of the Reflexion (Shinn et al. 2023) Actor / Evaluator / Self-Reflection trio
- `BibleRulesCritic`: LLM-as-judge using Bible v7.4 NEVER-rules as rubric, returns `{score, pass, violations[], hint}`
- `SelfReflection`: takes failed-trial trajectory and produces a corrective hint
- If critic fails, regenerate with hint; max 2 passes; exit on first pass

**Phase 5 — Imperfection Injection (zero LLM calls):**
- Rule-based + probabilistic `ImperfectionInjector` with four policies:
  - `HesitatePolicy`: inject "嗯..." / "wait" / "我想想" with conditional probability
  - `SelfCorrectPolicy`: "nvm" / "算了"
  - `ClarifyPolicy`: soft re-question (not therapist-style probe)
  - `UncertaintyPolicy`: "可能吧" / "我也不知道哎"
- At most 1 imperfection token per turn

**Phase 6 — Persistence (no foreground LLM):**
- `EmotionStateStore.write` (Firestore)
- `MemoryAdapter.write` (async; Mem0 fact extraction)

### 2.3 The three-layer emotion model (the architectural centerpiece)

- **L1 — Theoretical base:** Plutchik 8-dim vector (joy, trust, fear, sadness, anticipation, disgust, anger, surprise), each in [0,1]
- **L2 — Transition mechanism:** A Markov decision process (MDP) over the UX state space, abstraction borrowed from EvoEmo (arXiv 2509.04310). Hand-tuned transition table v0; eval-harness-tuned later. NO genetic algorithm training.
- **L3 — UX expression:** 5-state enum (`WarmCurious`, `PlayfulTease`, `SoftConcerned`, `FirmDirect`, `QuietWitness`). Each maps to a Plutchik vector and to a one-line directive injected into the rewriter's prompt.

### 2.4 Per-turn LLM call budget

- Best case: 4 LLM calls (~3-4 s)
- Worst case: 9 LLM calls (~8-12 s)
- 5/17 modules are LLM-invoking; 12/17 are pure deterministic logic.

### 2.5 Prior research we are leaning on

- **Reflexion** (Shinn et al., NeurIPS 2023, arXiv:2303.11366) — Actor/Evaluator/Self-Reflection loop
- **DSPy Refine + BestOfN** (Stanford NLP) — production pattern for the same loop
- **EvoEmo** (Long et al., arXiv:2509.04310, 2025) — emotion as MDP for negotiation agents (no public code)
- **Big5-Chat** (Liu et al., ACL 2025) — trait-grounded dialog corpus
- **DPRF** (arXiv:2510.14205, 2025) — dynamic persona refinement framework
- **Generative agents** (Park et al., NeurIPS 2024, arXiv:2411.10109) — interview-grounded 1052-person agent simulation
- **Plutchik wheel** (1980) — 8-dim affective theory base
- **Mem0** (arXiv:2504.19413) — production memory layer
- **Calibrated uncertainty** (Kadavath et al., 2022, Anthropic) — inspiration for ImperfectionInjector

### 2.6 Failure modes we are trying to fix (observed in production sim audit, rev 00056, 2026-04-29)

- **F1 — Verb-phrase mirroring:** Claire echoes user's verb-noun structure ("分代码" → Claire next turn "分代码")
- **F2 — Length escalation:** drift to multi-paragraph replies in long sessions
- **F3 — Code-switch drift:** mid-conversation Chinese leak when user is firmly English
- **F4 — Self-repeat advice:** same suggestion recycled across consecutive turns under paraphrase

---

## 3. Research questions — answer ALL of these with citations

Please structure your final report as exactly the seven sections below. For each citation, give a URL or DOI. If a claim is uncertain, mark it as such.

### Q1. Reflexion-style self-critique on chat (not code) tasks — does it actually work?

The Reflexion paper (91% pass@1 vs 80% baseline on HumanEval) demonstrates strong gains on **objective coding tasks** with binary success signals. We are applying the pattern to **subjective conversational quality** with LLM-as-judge as the evaluator.

- Find published evidence (papers, blog posts, OSS replications, evals) of Reflexion or DSPy-Refine-style critic loops applied to **dialog quality / persona consistency / safety alignment** rather than code/QA.
- Quantify the gain (or lack thereof) in those settings.
- What are the documented FAILURE MODES of LLM-as-judge for persona/style compliance? (E.g., judge collusion, criterion drift, length bias, sycophancy bias, position bias.)
- Is N=2 in-turn passes the right budget? Find any work that has searched over N for chat critic loops.
- Is there published work on critic-loops where the critic is a **smaller** model than the actor (we plan Qwen-1.5B as critic, Qwen-7B as actor)? Any quality cliff?

### Q2. Emotion-as-MDP for companion (non-adversarial) settings

EvoEmo's MDP is in adversarial price-negotiation. We are applying it to companion / emotional-support dialog.

- Find published or productionized examples of finite-state emotion machines / discrete affective state machines / mood DAGs in **companion / chatbot / emotional-support agents**.
- What state-space cardinality has worked in production? (3 states? 5? 7? 15? continuous?)
- Has anyone published the actual transition table they used?
- Are there alternative formalisms we should consider — e.g., continuous valence-arousal-dominance (VAD) model, OCC 22-emotion model, or learned latent-state controllers?
- What is the published evidence that *explicit emotion state control* beats *letting the LLM decide* in companion settings?

### Q3. Plutchik (1980) as theoretical base — is this load-bearing or decorative?

We anchor our 5-state UX layer in Plutchik's 8-dim wheel. We claim "50 years of psychology backbone."

- Is Plutchik still considered current in affective computing in 2024-26? Or has it been displaced by VAD, PANAS, or learned embeddings?
- Find published critiques of Plutchik in the LLM context — does it actually transfer to text-based affect modeling?
- Are there better-validated emotion taxonomies for **East Asian / Chinese language** affect? (Western emotion taxonomies have known cultural blind spots — e.g., 委屈, 不甘, 释怀, 心累 don't map cleanly.)

### Q4. The "ImperfectionInjector" idea — has anyone built this and reported results?

We propose a rule-based module that injects hesitation tokens, self-corrections, soft clarifications, and uncertainty markers into otherwise-clean LLM output to make it sound more human. Bible cap: ≤1 token per turn.

- Find any published or productionized work on **deliberately injecting human disfluencies / verbal hesitations / self-corrections into LLM output** for perceived humanness.
- This is the OPPOSITE direction from most LLM research (which makes outputs cleaner, more confident). What does the (small) literature on this say?
- Has Replika / Character.AI / Pi / Inflection / Hume EVI published anything on this technique?
- What are the documented failure modes? (E.g., does it backfire — users perceive the AI as malfunctioning rather than human?)
- What is the right firing rate? Our v0: ~30% probability when emotion state is `SoftConcerned`/`QuietWitness`. Is there any data?

### Q5. Companion AI in production — what does the field actually do?

- For each of: **Replika, Character.AI, Pi (Inflection), Hume EVI, Anima, Soulmachines, Glow.ai (China), MiniMax Hailuo (China), Xiaoice (Microsoft Asia), 星野 (MiniMax)** — summarize whatever is publicly known about their cognitive architecture.
- Specifically: do they use emotion state machines? Critic loops? Memory layers? Persona prompts only? Fine-tuning?
- Which of these are open-source enough to study?
- What is the typical per-turn latency they target?
- Find any postmortems / blog posts where companies describe what worked and what failed.

### Q6. Mem0 vs alternatives — does our choice matter?

- We use Mem0. Letta and Zep are claimed competitors. The LoCoMo benchmark dispute between Mem0 and Zep is documented and contentious.
- For our specific use case (Chinese conversational companion, ~50-200 turns per user, personalization recall is the dominant query type), is Mem0 the right pick?
- Would Letta's stronger long-horizon agent state buy us anything we need?
- Is there any published evidence that fact-extraction-quality differences across Mem0/Letta/Zep meaningfully affect downstream perceived companion quality?
- Are there Chinese-language-specific memory layers we should know about?

### Q7. Architecture-level: anything we are missing or doing wrong?

This is the most important section. Be skeptical. Push back.

- What known anti-patterns in companion AI is this architecture stepping into?
- Is the layered defense (LLM critic + deterministic strip) actually robust, or is it likely to develop conflicts where the critic rewrites something the strip then breaks (or vice versa)?
- Is the per-turn LLM call budget (4-9 calls) realistic for a chat product, or is the user latency expectation going to make this dead-on-arrival?
- Is there a fundamentally simpler architecture (e.g., **single-pass prompt with structured output + inline critic in one call**, or **fine-tune a 7B model on persona traces and skip the runtime architecture entirely**) that we should consider before committing to 4 weeks of engineering?
- Is there a published case study where someone built something architecturally similar and abandoned it? Why?
- What's the strongest argument AGAINST this architecture?

---

## 4. Output format we want back

Please return your research as a single document with this exact structure:

1. **Executive Summary** (≤ 300 words). Top 3 risks. Top 3 confirmations. One overall verdict: PROCEED / PROCEED-WITH-MODIFICATIONS / RECONSIDER / ABANDON.
2. **Section Q1 through Q7** — answer each with citations (URLs/DOIs required, no hand-waving).
3. **Contradicting evidence we should worry about** — list everything you found that argues against any specific design choice. Don't soften.
4. **Stronger alternatives we didn't consider** — if you found a better architecture, describe it and cite sources.
5. **Recommended modifications** — concrete changes to the architecture, ranked by ROI vs effort. Each with citation backing.
6. **Open questions you couldn't answer** — what would need a real-world experiment, not literature search.
7. **References** — full list, alphabetized.

---

## 5. What we already considered and rejected (do not re-recommend)

- LangGraph (founder constraint)
- Migrating to a bigger model (constraint)
- Switching memory layer to Letta or Zep (interface keeps it open; not changing now)
- Importing DSPy or Reflexion as Python libraries (we're TypeScript)
- Building a tool-using agent (Claire doesn't call tools)
- Importing Agent TARS / UI-TARS / OpenManus (GUI agent stack — domain mismatch, evaluated and rejected)
- Fine-tuning the base model (we don't own training infrastructure)
- Multi-agent orchestration (single agent is the product)

---

## 6. Date / freshness

We need 2024-2026 citations preferentially. Companion AI / persona-consistency / cognitive-architecture-for-LLMs is moving fast. A 2022 paper on Reflexion is fine because we're using it as foundation; a 2022 paper on companion-AI architecture is probably stale.

---

**END OF PROMPT.** Please be thorough and skeptical. We would rather discover this architecture is broken in a research report than after 4 weeks of engineering.
