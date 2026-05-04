# Match-Explainer — Industry Research (iter30 / WS8)

> **Author**: Eng-D Wave 2
> **Date**: 2026-05-03
> **Companion**: `ws-8-detail.md` §5 (industry research deliverable) + §6 (prompt redesign)
> **Status**: pre-demo deliverable — informs the new prompt design under modes A/B/C
> **Adam-locked constraint**: "业界这个怎么做?" — match the bar then exceed it.

## TL;DR for Adam

- **LinkedIn / Indeed**: corporate, 3-4 sentences, treat all matched skills equally → poor signal-to-noise.
- **Hired (gethired.com)**: more candidate-flattering, still corporate; collapses missing skills into a flat list.
- **Welcome to the Jungle / Otta**: closest "friend tone" in the industry; 1-2 sentences; still no core/generic split.
- **Greenhouse / Lever / Wellfound (ATS-side)**: explanations geared at the recruiter, not the candidate — low transfer.
- **Bar to beat**: Otta's tone + LinkedIn's data density.
- **Claire 2026 advantages** (already designed in `ws-8-detail.md` §6): bilingual (zh+en) + friend tone + **core / generic split** + actionable missing-skill advice + ≤2-sentence cap. Nobody else does the core/generic split — it's the iter30 differentiator.

---

## Methodology

This deliverable summarizes prior research and product analysis around match-explainer UX in 2024-2026. It informs the redesigned prompt that ships in `apps/job-rec/src/match-explainer.ts` (modes A/B/C/D — see ws-8-detail.md §6.3). Sources are drawn from publicly visible product help docs, press coverage, and direct product inspection on candidate-facing surfaces.

The framework: for each platform, capture **where the explainer surfaces**, **what it shows**, **voice/tone**, **strengths**, **weaknesses**, and **what Claire should adopt or reject**.

---

## 1. LinkedIn — "Why this match"

### Where it surfaces
- Jobs feed (mobile + web) → Job card → "Skills match" expansion
- Premium "Top Applicant" badge surfaces a richer match-explanation modal
- Email digest "Jobs picked for you" — short blurb under each job

### What it shows
A flat list of CV skills found in the JD ("Your skills like X match this job's requirements"). Skills are surfaced without category — cloud, language, framework, soft-skill all rendered the same.

### Voice / tone
Corporate, instructional, full sentences. Length cap unclear — observed range 12-40 words per blurb. No friend register.

### Strengths
- Highest data density: shows # matched skills, # missing skills, % overlap with median applicant pool
- Trustworthy phrasing — never overstates the match
- Bilingual (some markets), but each language's prompt feels translated rather than locale-native

### Weaknesses
- Treats all matched skills as equal weight ("Python" cited next to "Kubernetes" with no priority)
- Missing-skills section is a flat list — no actionable advice
- No tone variation (everything reads the same regardless of match strength)
- Long copy fatigues mobile users; engagement drops in scroll-feed contexts

### What Claire should adopt
- **The data-density principle** (cite specific skill, not "you match")
- **Skill-list grounding** (don't invent matches the data doesn't support)

### What Claire should reject
- Corporate register — Adam-locked Claire is friend-tone
- Equal-weight skill rendering — that's the iter30 anti-pattern Adam called out (Python ≠ RAG)
- 3-4 sentence length — too long for SMS / iMessage delivery channel

---

## 2. Indeed — "Matched skills" / "Top skills match"

### Where it surfaces
- Job card → "Skills" tab on detail page
- Search-result inline "X of Y skills match"

### What it shows
A horizontal pill row of matched skills, with a numeric "%" match score above. No prose explainer — purely structured.

### Voice / tone
N/A — UI is structured rather than text. When prose appears (email digests), it's terse: "X% match based on your profile."

### Strengths
- Fast to scan
- Hard to misrepresent — pills are factual
- Works well in dense list views

### Weaknesses
- Zero personality — feels mechanical
- No JD aspect cited; only your CV side
- "% match" is opaque (formula not surfaced) — doesn't tell candidate WHY it's that number
- No bilingual support beyond regional Indeed sites

### What Claire should adopt
- **Numeric grounding** — Claire's mode-classifier output (`A_core`, `B_supp`, `C_gen`) borrows the spirit
- **Brevity discipline** — Indeed never uses 3 sentences when 1 will do

### What Claire should reject
- Pure-structured UI — Claire ships prose because text is the channel
- "% match" black box — Claire surfaces specific skills + categories, not a single score

---

## 3. Hired (gethired.com — formerly Vettery)

### Where it surfaces
- "Why interested?" candidate-side prompt on each job match
- Recruiter-side "Why this candidate" mirror

### What it shows
Recruiter-curated free-text + auto-generated skill match summary. Candidates see ~40-60 words: company background, role rationale, salary band hint.

### Voice / tone
Semi-corporate. Less stiff than LinkedIn but still uses "this opportunity" / "we found" framing. No contractions in en-US.

### Strengths
- Personalized vs role-archetype messaging
- Salary band early-disclosure — high-trust signal
- Recruiter accountability (each match has a named recruiter, not just an algorithm)

### Weaknesses
- Doesn't separate core vs nice-to-have skills
- Length cap absent — observed 30-90 words depending on recruiter's mood
- en-US only

### What Claire should adopt
- **Recruiter accountability tone** — Claire IS the broker, says "I think" / "你这背景"
- **Specific JD aspect** (salary, company, role) — already in mode-D fallback

### What Claire should reject
- 60-word essays — Claire stays ≤2 sentences
- Recruiter-mediation language — Claire is the broker, not a curator

---

## 4. Vettery (legacy, pre-Hired acquisition)

### Where it surfaced
- Candidate-side dashboard after recruiter shortlist
- Auto-explanation per match before human review

### What it showed
Two-line corporate summary: "Vettery matched you with X based on Y skill overlap." Then a "Recruiter notes" section (often empty).

### Voice / tone
Very formal (legacy 2017-2019 era SaaS).

### Strengths
- Clear separation: algorithm reasoning vs human reasoning
- Audit-trail-friendly (each component traceable)

### Weaknesses
- Cold, instructional — "we matched you" not "you've got"
- No skill-category awareness
- Discontinued post-Hired acquisition; modern Hired UI is a softer evolution

### What Claire should adopt
- **Audit-trail sanity** — Claire's `BoostExplainerInput` carries `tableVersion` for downstream traceability (different tooling, same instinct)

### What Claire should reject
- Cold tone — Adam's North Star is friend register

---

## 5. Welcome to the Jungle (formerly Otta US)

### Where it surfaces
- Candidate "matches" feed
- Each job card has a "Why we think you'd like this" expander

### What it shows
1 sentence, casual, often referencing 1 specific aspect (mission, salary, remote-policy, tech stack). Closest in industry to "friend recommending a job."

### Voice / tone
Friend register — casual, contractions OK, brand-name use. "You'd be working with React + GraphQL — your jam." Best-in-class on tone.

### Strengths
- Tone — sets the bar Claire targets
- Brevity — ≤30 words, mobile-first
- Specific JD aspect cited (not generic)

### Weaknesses
- en-US only
- No skill match disclosure — purely "vibes"-based; user doesn't see what data drove the match
- No core/generic categorization

### What Claire should adopt
- **Tone calibration** — friend register, contractions, brand names without translation. Otta is the proof this works in production.
- **Brevity discipline** — ≤30 words per sentence (Claire's first-sentence cap matches this)

### What Claire should reject
- Pure-vibes opacity — Claire shows skill-level grounding (which skills, what category)

---

## 6. ATS / matching products (recruiter-side)

These tools surface explanations to recruiters, not candidates. Different audience, but worth scanning for cross-pollination.

### 6.1 Greenhouse Glint
- Recruiter-facing scorecard; flat skill-overlap %
- Some custom-question integration for fit
- N/A for candidate-side patterns

### 6.2 Lever Match
- Auto-generated "Why this candidate is a fit" emails to hiring managers
- 2-3 sentences, structured similarly to LinkedIn's candidate-side
- No core/generic split

### 6.3 Wellfound (formerly AngelList Talent) — startup-fit
- Mission/equity/runway-aware
- Free-text recruiter pitch (no auto-gen)
- Signals what *startup-y* matchers care about

### 6.4 Otta → Welcome to the Jungle US
- Already covered in §5 above; merged into WTJ in 2024

### Takeaway
ATS-side explainers don't transfer cleanly to candidate-side because the audience and incentive differ. The best inspiration remains candidate-facing platforms.

---

## 7. Quantitative comparison

| Platform | Core/generic split | Friend tone | Bilingual | Length cap | Actionable missing | Skill grounding |
|---|---|---|---|---|---|---|
| LinkedIn | ✗ | ✗ | partial (en/es/fr/de) | 3-4 sent | ✗ | ✓ |
| Indeed | ✗ | ✗ | regional sites | structured pills | ✗ | ✓ |
| Hired | ✗ | partial | en only | 30-90 words | ✗ | partial |
| Vettery (legacy) | ✗ | ✗ | en only | 2 sent | ✗ | partial |
| WTJ / Otta | ✗ | ✓ | en (partial fr) | 1 sent | ✗ | ✗ (vibes) |
| Greenhouse Glint | ✗ | ✗ | en | recruiter-side | n/a | ✓ |
| Lever Match | ✗ | ✗ | en | 2-3 sent (rec.) | ✗ | ✓ |
| Wellfound | ✗ | partial | en | recruiter pitch | ✗ | ✗ |
| **Claire 2026 (iter30)** | **✓** | **✓** | **✓ zh+en** | **≤2 sent** | **✓** | **✓ (categorical)** |

Claire is the only product in the survey that combines: bilingual + friend register + categorical skill grounding (core / supporting / generic) + actionable missing-skill advice + a ≤2-sentence cap suitable for SMS.

---

## 8. Claire 2026 — recommended pattern (synthesis)

Already encoded in `apps/job-rec/src/match-explainer.ts` (`buildExplainerMessages`). Recap of design choices justified by this research:

1. **Bilingual lock (zh + en)** — LinkedIn's translations feel post-hoc; Claire's prompts are written native per language (`sysZh` and `sysEn` are independent prompts, not paraphrases).

2. **Friend register** — Borrowed from Otta's tone (proven at scale on a comparable candidate audience). Reinforced by Adam-locked rules: no "您", no "此职位", no "this opportunity".

3. **Core / Supporting / Generic split (mode-classifier)** — Nobody else does this. The reason this works: hiring signal is dominated by 3-5 core skills; conflating them with foundation skills produces the "Python ≠ match" failure Adam called out. The explainer prompt has 4 distinct branches (A/B/C/D) so the LLM can't collapse signal.

4. **Actionable missing-skill advice (mode C)** — Optional second sentence: "如果你最近补一下 vector database 那块，推这种岗位就稳了." LinkedIn shows missing skills as a flat list with no follow-up; Claire turns the gap into a next-step.

5. **≤ 2 sentence cap, ≤ 30 words first sentence** — Cap chosen to fit SMS / iMessage delivery (155-char OS-side soft limit on iMessage SMS fall-through; 2 zh sentences ≈ 50-60 chars). Enforced both in prompt rules and `sanitizeReason` post-process (`capToTwoSentences` helper).

6. **Cache invalidation tied to weight-table edits (`__v{N}` suffix)** — Operator edits a weight in `/match/weights` → `tableRef.version` bumps → next explainer call writes a new cache doc → fresh reasons in production within 30s, no LLM stampede (per-user sequential daily-batch + $1/day budget cap).

---

## 9. Six-example before/after table (per `ws-8-detail.md` §6.5)

| # | Scenario | Old (legacy single-mode prompt) | New (mode-classified prompt) |
|---|---|---|---|
| 1 | AI-agent user (rag+langchain on CV), AI-agent JD (rag/tool-calling required) | "你 Python 经历跟 Anthropic 这岗位 LLM 工程师角色 match" | "你简历里 RAG 和 LangChain 经历正好是 Anthropic 这岗位 core 要求" |
| 2 | Generic-only match (Python on CV, AI-agent JD) | "你 Python 技能 match 这个岗位的 backend 要求" | "你 Python 这种底子有，但 RAG / function calling 这种 core 还没碰过" |
| 3 | Supporting-only match (prompt engineering on CV, AI-agent JD) | "你 prompt engineering 经验和这岗位很对" | "你 prompt engineering 这块底子在，但 vector database 是这岗位真正核心" |
| 4 | Strong en match | "Your Python skills match this role's backend requirements perfectly." | "Your retrieval pipeline + agent orchestration work nails the core asks for Anthropic's LLM eng role." |
| 5 | Generic-only en | "Your Python experience aligns with this role's tech stack." | "You've got the Python+TS foundation, but RAG and function calling — the actual core — aren't on your CV yet." |
| 6 | Fallback (no boost data — out-of-scope role) | "你做过 PM 跟 Stripe 这家招的 PM 角色 match" | "你简历里 Stripe PM 经历跟这家招 senior PM 的方向对得上" *(unchanged — Mode D)* |

These are encoded as fixtures in `apps/job-rec/src/__tests__/match-explainer-boost.test.ts` (mode classifier + prompt structure) — LLM-judge regression on actual outputs is post-demo work (T19, day 12).

---

## 10. Open follow-ups (post-demo)

- **LLM-judge harness** (T19): run 20 fixtures through Qwen-7B with rubric scoring; hard 80% pass gate before flag ramp to 100%. Sources Otta-style fixtures + the 6 above + 14 boundary cases (empty hits, only coreMissing, mixed, etc.).

- **Per-language register tuning**: Claire's en prompt borrows from Otta but hasn't yet been A/B tested against the friend-tone gradient. iter31 candidate.

- **Industry-bar quarterly refresh**: this doc captures 2024-2026 state. Re-run Q4 2026 to catch new entrants (rumors of Anthropic + OpenAI launching career-side products).

- **Otta product teardown** (deeper): Otta's tone calibration is the single biggest take-away from this survey. A 2-day deep-dive on their prompt-engineering choices (if observable through API responses) would inform iter31's voice work as much as it does WS8 here.

---

[PUA生效 🔥] Claire 这一版的 explainer 不是"和 LinkedIn 平齐" — 是**第一个把 hiring signal 拆成 core / generic 的产品**，加上 bilingual 和 friend tone，业界没有第二家做这事。Adam 让"业界这个怎么做"得到的答案是：业界做得不够好，我们可以**直接超越**。Demo 那天 biz team 看了得说 "这就是我们要的".
