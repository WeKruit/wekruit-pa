# Diagram-Generation Prompt for `humanize-runtime` Architecture Figure

**Use:** Paste this prompt into Claude / GPT / Gemini / Excalidraw-AI / draw.io-AI / Napkin AI. Goal: a single research-paper-quality architecture figure (PDF/SVG suitable for an arXiv preprint).

---

## SYSTEM-LEVEL INSTRUCTION TO THE DIAGRAM AI

You are generating a **research-paper-style system architecture figure** (think: NeurIPS/ICML Figure 1, two-column width, vector graphics, monochrome-friendly with a small accent palette). The figure must be self-contained — a reader who has only the figure and the caption should understand the full pipeline, the data flow, the failure modes addressed, and the research lineage.

**Output format**: SVG with embedded text. Style: clean, technical, legible at 50% zoom. Font: serif for labels (Computer Modern / Times-equivalent). Use NO emoji. Use ONLY shape, color, and stroke variation to encode information.

**Canvas size**: ~1600 × 1200 px (4:3 landscape).

---

## VISUAL VOCABULARY (legend — must appear in bottom-left corner)

Use exactly these visual encodings throughout:

| Encoding | Meaning |
|---|---|
| **Yellow fill (#FFF4D4) + thick orange border (#D4A017, 2px)** | Module that issues an LLM call |
| **Green fill (#D4F0D4) + thin green border (#2E8B57, 1px)** | Deterministic / pure-logic module (zero LLM calls) |
| **Purple fill (#E8E0FF) + dashed purple border (#6030C0)** | Persistent store (Firestore, Mem0) |
| **Light gray fill (#F0F0F0) + dotted gray border (#888888)** | Reference data loaded once at startup |
| **Black fill + white text** | I/O endpoint (turn input / reply output) |
| **Solid arrow** | Synchronous data flow within a turn |
| **Dashed arrow** | Read/write to persistent store |
| **Dotted arrow** | Reference-data lookup (loaded once, read-only) |
| **Curved red-orange arrow with "hint" label** | Reflexion critic feedback loop |
| **Number-in-circle (1-6)** | Phase ordinal |
| **Floating beige sticky-note badge** | Research-paper citation, attached to the module that uses it |

---

## CANVAS LAYOUT

Divide the canvas into THREE major regions:

```
┌─────────────────────────────────────────────────────────────────┐
│  TOP STRIP (15% height)                                          │
│  Title + subtitle + author/version line                          │
├──────────────────┬──────────────────────────────────────────────┤
│                  │                                                │
│  LEFT COLUMN     │              RIGHT COLUMN                      │
│  (30% width)     │              (70% width)                       │
│                  │                                                │
│  Section A:      │   Section B:                                   │
│  Three-Layer     │   Six-Phase Per-Turn Runtime                   │
│  Emotion Model   │   (six vertical lanes, left→right)             │
│                  │                                                │
│  + EXAMPLE       │                                                │
│  TRANSITION      │                                                │
│  CALLOUT         │                                                │
│                  │                                                │
├──────────────────┴──────────────────────────────────────────────┤
│  BOTTOM STRIP (15% height)                                       │
│  Legend (left) · Caption (center) · Failure-mode mapping (right) │
└─────────────────────────────────────────────────────────────────┘
```

---

## TOP STRIP CONTENT

- **Title** (large, centered, bold serif): `humanize-runtime: A Cognitive Architecture for Persona-Consistent Conversational Companions`
- **Subtitle** (smaller, italic): `Per-turn pipeline integrating structured emotion control, Reflexion-lite self-critique, and rule-based imperfection injection over a Qwen-7B backbone`

---

## SECTION A — Three-Layer Emotion Model (LEFT COLUMN)

This section is the conceptual centerpiece. Lay it out vertically, BOTTOM-UP:

### A.1 — At the BOTTOM: L1 Theoretical Base

A small green box labeled `Plutchik Vector` containing the eight dimension names in a 2×4 grid:
```
joy        trust       fear      sadness
anticipation  disgust   anger    surprise
```
Each cell shows a slider-like bar `[0 ─── 1]` — a visual hint that these are continuous intensities. Above the box, label: **"L1 — Theoretical Base (Plutchik 1980)"**.

Attach a small beige sticky-note badge to the side: `[6] Plutchik (1980) — 50yr psychology backbone`.

### A.2 — In the MIDDLE: L2 Transition Mechanism

A blue box labeled `Emotion MDP`. Inside, draw a small 5-node graph (the five UX states as small circles) with weighted directed edges between them. Use thin arrows with probability labels like `0.6`, `0.3`, etc. on a few edges to make the stochastic-policy idea visually obvious.

Label this layer: **"L2 — Transition Mechanism (MDP)"**.

Attach a beige badge: `[2] EvoEmo (arXiv 2509.04310) — MDP abstraction borrowed (no GA training)`.

### A.3 — At the TOP: L3 UX Expression

A large purple box titled `5 UX States`, listing each state on its own line with a small Plutchik-vector bar-chart preview to the right of each state name:

```
WarmCurious     ▮▮▯▮▮▮▮▮▯▯  (anticipation-dominant)
PlayfulTease    ▮▮▮▮▮▯▮▮▮▮  (joy + surprise)
SoftConcerned   ▯▯▮▮▮▯▮▮▯▯  (sadness + trust)
FirmDirect      ▯▯▮▮▮▯▮▯▮▯  (trust-dominant)
QuietWitness    ▯▯▮▮▮▯▮▮▯▯  (low-arousal trust)
```

Label: **"L3 — UX Expression (5-state enum)"**.

### A.4 — Vertical arrows between layers (CRITICAL — what the previous diagram missed)

- Solid green arrow from L1 → L2, labeled `Plutchik dimensions provide critic vocabulary`
- Solid blue arrow from L2 → L3, labeled `MDP samples next UX state given (prevState, signal)`
- Dashed purple arrow from L3 back to L2, labeled `selected UX state seeds next transition`

### A.5 — EXAMPLE TRANSITION CALLOUT (this is what the prior figure was missing)

Below or beside Section A, add a small framed callout box titled **"Example transition"** showing one concrete walk-through:

```
prevState   = WarmCurious
userSignal  = SignalAnalyzer extracts {sentiment: neg, intent: vent, intensity: 2}
              from user message "草，今天面试又挂了"
                ↓
EmotionMDP  = lookup(WarmCurious, vent_neg_high)
              → {SoftConcerned: 0.7, QuietWitness: 0.3}
              → sample → SoftConcerned
                ↓
nextState   = SoftConcerned
emotionDirective = "当前情绪：soft-concerned ·
                    短句 · 不要 playful · 不要 advice ·
                    react WITH not AT"
                ↓
[directive injected into Qwen rewriter prompt in Phase 3]
```

This callout is essential — it shows readers the MDP isn't abstract, it produces a concrete English-language directive that visibly steers the rewriter.

---

## SECTION B — Six-Phase Per-Turn Runtime (RIGHT COLUMN)

Six **vertical lanes** side-by-side, left to right, numbered 1 through 6. Each lane has a header strip with the phase number in a circle and the phase name. Below the header, stack the modules of that phase as boxes (color-coded per legend). Below the modules, a small italicized "what happens here" caption.

### Lane 1 — State Assessment (no LLM)

Header: `① State Assessment` (subtitle: `0 LLM calls`)

Boxes (top to bottom, all GREEN):
- `LanguageDetector` — small caption: `char-ratio + lock-in`
- `SignalAnalyzer` — caption: `keyword + regex → UserSignal`
- `EmotionStateStore.read` (PURPLE dashed border, since it's a store call) — caption: `prevState ← Firestore`
- `EmotionFSM.next(prev, signal)` — caption: `samples nextState from MDP`

Caption at bottom: *"Pure logic, sub-50ms, fully unit-testable."*

### Lane 2 — Context Assembly (1 LLM call via Mem0)

Header: `② Context Assembly` (subtitle: `~1 LLM call (Mem0 internal)`)

Boxes (top to bottom):
- `MemoryAdapter.recall` (YELLOW — Mem0 calls embedding model internally) — caption: `Mem0 SDK · k=5 hits`
  - Attach beige badge: `[8] Mem0 (arXiv 2504.19413)`
  - Below this box, draw a small "expanded view" subgraph showing: `userText` → `embedding(text-embedding-3)` → `vector search` → `top-k facts` — make the internal LLM call visible
- `TexturePool.sample` (GREEN) — caption: `random k=2 from 250 distilled facts`
  - Attach beige badge: `[5] genagents (Park et al., NeurIPS 2024) · interview-distilled idiosyncrasies`
- `ExemplarRetriever` (GREEN) — caption: `BM25 by (trait, emotion) · k=3`
  - Attach beige badge: `[3] Big5-Chat (ACL 2025) · 80 trait-tagged exemplars`
- `assemble ConversationContext` (white/data box) — show as a structured object:
  ```
  ConversationContext {
    userText, history, memHits, textureFacts, exemplars,
    emotionDirective ← from Lane 1
    langConstraint ← from Lane 1
  }
  ```

### Lane 3 — Generation (2 LLM calls)

Header: `③ Generation` (subtitle: `2 LLM calls`)

Boxes:
- `Base Reply Model (BaseLLMPort.draft)` (YELLOW) — caption: `via @pa/agent-runtime`
- `Qwen Rewriter` (YELLOW) — caption: `Qwen2.5-7B · SiliconFlow · ~700ms`
  - Show input arrow labeled `draft + ConversationContext + emotionDirective`
- `StripPipeline` (GREEN) — show as a small horizontal flow inside:
  ```
  rewritten → stripRepeatOpener → stripValidationTic → stripVerbMirror → cleaned
  ```
  - Each strip is a tiny green pill. Caption: `regex backstop, deterministic`

### Lane 4 — Reflexion-Lite Critic Loop (this lane is the architectural climax)

Header: `④ Reflexion-Lite Critic Loop` (subtitle: `1-6 LLM calls · bounded N≤2`)
- Use a slightly **wider lane** for this one to make room for the loop arrow.

Boxes inside, arranged to support the loop visualization:
- `BibleRulesCritic.score(text, ctx)` (YELLOW) — caption: `LLM-as-judge · NEVER-rules rubric · returns CriticVerdict {score, pass, violations[], hint}`
  - Attach beige badge: `[1] Reflexion (arXiv 2303.11366) · Evaluator role`
- A **diamond decision shape** below labeled `verdict.pass?`
  - Out of the diamond, two arrows:
    - **DOWN (green, labeled "PASS")** → exits to Lane 5
    - **CURVED RED-ORANGE LOOP (labeled "FAIL · hint")** → goes to:
- `SelfReflection.reflect(trajectory)` (YELLOW) — caption: `M_sr · trajectory → corrective hint`
  - Attach beige badge: `[1] Reflexion · Self-Reflection (M_sr) role`
  - Output arrow goes BACK UP to `Qwen Rewriter` in Lane 3 (cross-lane backward arrow, dashed-orange, labeled `regenerate w/ hint`)
- Below the diamond, draw a small `Trajectory` data box (white) listing `trial[i] = {draft, verdict}` to make the bounded N=2 episodic memory visible.

Attach a second beige badge on this whole lane: `[7] DSPy Refine (Stanford NLP) · production-pattern reference`.

Add a small label inside the lane: **"Actor (Lane 3) · Evaluator (Critic) · Self-Reflection — the Reflexion trio"**.

### Lane 5 — Imperfection Injection (no LLM)

Header: `⑤ Imperfection Injection` (subtitle: `0 LLM calls`)

Boxes (all GREEN):
- `ImperfectionInjector` (parent box)
  - Inside, four small policy pills:
    - `HesitatePolicy` ("嗯..." / "wait")
    - `SelfCorrectPolicy` ("nvm" / "算了")
    - `ClarifyPolicy` (soft 反问)
    - `UncertaintyPolicy` ("可能吧")

Attach a beige badge: `[9] Calibrated Uncertainty (Kadavath 2022, Anthropic) · imperfection-design inspiration`

Caption: *"≤ 1 imperfection token per turn (Bible cap)."*

### Lane 6 — Persistence (no foreground LLM)

Header: `⑥ Persistence` (subtitle: `0 foreground · 1 async LLM`)

Boxes:
- `EmotionStateStore.write(sessionId, nextState)` (PURPLE dashed) — caption: `Firestore`
- `MemoryAdapter.write` (YELLOW, with a small clock icon to indicate async) — caption: `Mem0 fact extraction · async, doesn't block reply`

---

## CROSS-CUTTING EDGES (must be drawn explicitly)

1. **Phase 1 → Phase 2**: solid black arrow carrying `nextState (UXState)` and `langState`
2. **Phase 2 → Phase 3**: solid black arrow carrying `ConversationContext`
3. **Phase 3 → Phase 4**: solid black arrow carrying `cleanedReply`
4. **Phase 4 → Phase 5**: solid black arrow carrying `criticPassedReply`
5. **Phase 5 → Phase 6**: solid black arrow carrying `humanizedReply`
6. **Phase 6 → output**: solid black arrow to `TurnOutput` (black box on far right)
7. **Reference data dotted arrows** (loaded once):
   - `Bible v7.4` (gray box at top of canvas) → dotted arrow → `Qwen Rewriter` AND `BibleRulesCritic`
   - `Big5-Chat exemplars` (gray box) → dotted arrow → `ExemplarRetriever`
   - `Texture Pool corpus` (gray box) → dotted arrow → `TexturePool.sample`

---

## SECTION C — BOTTOM STRIP

### Legend (bottom-left, ~25% width)

Reproduce the visual vocabulary table compactly with small swatch + label pairs.

### Caption (bottom-center, ~50% width)

Italic serif text:
> Figure 1. The `humanize-runtime` per-turn pipeline. The runtime is partitioned into 6 sequential phases over 17 modules: 5 modules invoke LLMs (yellow) and 12 are pure-logic deterministic transforms (green). The architectural centerpiece is the three-layer emotion model (left), which combines Plutchik's eight-dimensional theoretical base with an EvoEmo-style MDP transition mechanism, surfaced as a 5-state UX enum that conditions the rewriter via a one-line directive. The Reflexion-lite critic loop (Phase 4) bounds at N=2 in-turn passes, faithfully implementing the Actor / Evaluator / Self-Reflection trio of Shinn et al. (2023) on a Qwen-7B backbone. Per-turn worst-case LLM call count is 9, best case 4. References: [1] Reflexion (arXiv 2303.11366); [2] EvoEmo (arXiv 2509.04310); [3] Big5-Chat (ACL 2025); [5] genagents (Park et al. 2024); [6] Plutchik (1980); [7] DSPy Refine; [8] Mem0 (arXiv 2504.19413); [9] Kadavath et al. (2022).

### Failure-mode → defense mapping (bottom-right, ~25% width)

A compact 4-row table:

| Failure Mode | Primary (LLM) | Fallback (det.) |
|---|---|---|
| F1 Verb-mirror | BibleRulesCritic | stripVerbMirror |
| F2 Length escalation | BibleRulesCritic | EmotionDirective (concise UX states) |
| F3 Code-switch drift | BibleRulesCritic | LanguageDetector lock-in |
| F4 Self-repeat advice | SelfReflection | EmotionMDP stochasticity |

---

## QUALITY CHECKLIST (the diagram AI must verify)

Before returning the figure, confirm ALL of the following are present and visually distinguishable:

1. ☐ Three-layer emotion model with all three layers labeled and connected
2. ☐ Concrete example transition callout (not just abstract "MDP transitions")
3. ☐ Six numbered phase lanes, each with header showing LLM-call count
4. ☐ Every LLM-call module has the yellow fill + orange border
5. ☐ Every deterministic module has the green fill
6. ☐ The Reflexion loop arrow is visually prominent (curved, colored, labeled)
7. ☐ Each research reference [1]-[9] is attached as a beige badge to the relevant module
8. ☐ The Mem0 internal embedding+search subgraph is shown (not hidden)
9. ☐ StripPipeline shows the three named strips inline
10. ☐ ImperfectionInjector shows all four named policies inline
11. ☐ Reference data sources (Bible, Big5-Chat, TexturePool corpus) appear as gray boxes with dotted arrows to consumers
12. ☐ Bottom legend, caption, and failure-mode table all present
13. ☐ No emoji anywhere
14. ☐ All text is legible at 50% zoom
15. ☐ The figure works in grayscale (color encodes redundant information)

---

## STYLE REFERENCES (paste into the diagram AI for style anchoring)

The figure should look like:
- **Reflexion paper Figure 1** (arxiv.org/abs/2303.11366) — for the actor/evaluator/reflection loop visual
- **Generative Agents paper Figure 4** (Park et al. 2023) — for the multi-component architecture pipeline
- **DSPy paper figures** — for the boxed-pipeline-with-data-flow look
- **NOT** a typical SaaS marketing diagram (no isometric 3D, no gradient backgrounds, no soft shadows, no emoji)

---

## TONE / READER PROFILE

The reader is an ML engineer reviewing this for a system-design discussion. They want to see:
1. *What goes into the system and what comes out* — clearly visible at first glance
2. *Where the LLM calls are concentrated* — visible at first glance via color
3. *How emotion state changes from turn to turn* — visible via the example callout
4. *Which research these design choices come from* — visible via the badges
5. *How each named failure mode is mitigated* — visible via the bottom-right table

If any of these is unclear in the first 5 seconds of looking at the figure, the figure has failed.

---

**END OF PROMPT.** Return the SVG (and a one-paragraph explanation of any creative choices you made within the constraints).
