# Companion Voice Research — Findings (2026-04-27)

Researcher pass against open-source companion-bot literature. Operator constraint: stay on `gpt-5.4-nano`, do NOT escalate to Sonnet. Research validates this constraint — small-model voice fixable via prompt structure, not bigger model.

---

## Top 3 highest-ROI levers (consensus across SillyTavern docs, Janitor, Ali:Chat, mental-wellness-prompts)

### L1 — First Message is the single most powerful field
SillyTavern docs (https://docs.sillytavern.app/usage/core-concepts/characterdesign/):
> "The model is more likely to pick up the style and length constraints from the first message than anything else."

**Action**: write the first message PA "would" send (e.g. on first contact, or right after `__PA_RESET__`) with the EXACT cadence/length/voice we want. Model anchors to it.

### L2 — Example Dialogue (few-shot) beats abstract personality descriptors
Ali:Chat technique: define character through dialogue examples in description, NOT adjective lists. Small models bind to demonstrated patterns far more than to descriptors.

**Action**: ship 2-3 `mes_example` turns alongside persona card. Cost ~150-300 tokens/turn, but documented as the highest-leverage technique for small-model voice.

### L3 — Negative instructions ("never say X") are broken on small models
Janitor AI advanced prompting:
> "Models don't filter like humans, they generate based on ingredients. 'No blood' is still 'blood.' 'Don't be rude' includes 'rude.'"

Our case: `Never say "好的，我记住了"` actually primes the token "记住". **Convert all anti-patterns to positive shown examples in `mes_example`.**

---

## Concrete anti-robotic patterns (the "好的，我记住" reflex)

| Robotic (current) | In-character (target) |
|---|---|
| 好的，我记住你喜欢喝柠檬茶 🍋🧋 | 柠檬茶女孩 🍋 行，下次催简历的时候配你一杯 |
| 记得的：你喜欢喝柠檬茶 🍋🧋 | 还能不知道？你那个柠檬茶 lol |

The principle: **use the fact, don't catalog it**. Ack happens by reference, not announcement.

---

## Other findings worth applying

### Post-history instruction injection
Character Card V2 spec adds `post_history_instructions`. Reason: rules at the *start* of long context get pushed up by recent turns. Re-inject 3-4 voice constraints right before user's latest turn. Adopt — cheap (50-100 tokens) and high-leverage on nano with moderate context.

### EmotionPrompt — marginal on small models
Microsoft NeurIPS 2023 (arXiv 2307.11760). 11 emotional-stake phrases improve large models. Caveat: *"the larger the LLM, the greater the benefits."* Smaller models benefit less.

**Action**: try ONE stimulus phrase (e.g. "this user is job-hunting and the messages matter to them"), A/B against eval. Don't stack three.

### Two-stage role-play prompting — REGRESSES on small models
Persona is a Double-edged Sword (arXiv 2408.08631):
> "Role-Play CoT significantly underperforms zero-shot CoT in smaller models like Llama2-7b, Llama3-8B, Qwen2-7b."

**Action**: assign persona once as background. Don't make nano "think in role" before answering.

### Length control
Mental-wellness-prompts repo + ST docs converge: hard cap in `first_mes` is the only reliable lever. SMS-style: 1-3 sentences, occasionally single word.

### Emoji policy
Community consensus: forbidding emoji entirely makes small models stilted. Whitelist 1-2 *character-specific* emoji as signature. Constrain frequency in system prompt ("uses emoji only when the moment naturally calls for it, never as decoration") AND show emoji-free examples alongside emoji ones.

### AI-overuse vocabulary (Chinese)
Empirically over-represented: `好的，我记住了 / 收到 / 没问题，我会记得 / 下次我会注意 / 收到 / 已记录`.

**Critical**: do NOT put these in a system-prompt blacklist (token activation). Put them in the **LLM-judge eval rubric as automatic-fail patterns**.

---

## Eval rubric (Phase 14 harness extension)

4 axes per response, pairwise (current prompt vs candidate):

| Axis | Score | Auto-fail trigger |
|---|---|---|
| In-character voice | 0/1 | matches phrase `好的，我记住了` / `收到` / `没问题，我会` / `I'll remember` |
| Memory ack style | 0=登记 / 1=中性 / 2=woven | uses storage-confirmation phrasing |
| Length appropriateness | 0/1 | >60 字 / >3 sentences in SMS context |
| Warmth without sycophancy | 0/1 | matches `好问题!` / `great question!` / `非常乐意为您` |

Judge model can be bigger than production model — only pay during iteration. Production stays nano.

---

## Concrete prompt structure to adopt (Character Card V2)

Field ranking by leverage on small models:

1. **`first_mes`** — voice anchor; the single most-load-bearing field
2. **`mes_example`** — 2-3 few-shot dialogue turns (Ali:Chat: dialogue-as-definition)
3. **`description`** — always-in-context facts (<200 tokens)
4. **`personality`** — short trait summary (<100 tokens)
5. **`scenario`** — situational framing
6. **`post_history_instructions`** — re-inject voice constraint before each generation

Total persona block budget: keep under ~500 tokens combined. W++/PList structured-attribute formats are token tax with diminishing returns under ~200B params — skip.

---

## Anti-list (research-validated NOT to do)

- ❌ Escalate to Sonnet — prompt structure fixes this on nano
- ❌ Multi-stage role-play / role-play CoT — regresses on small models
- ❌ Long persona biographies — token waste, no benefit
- ❌ Negative instruction lists — primes the very tokens you want to suppress
- ❌ Fine-tuning — no Character Bible yet, no anchor data, premature
- ❌ Stacking 3+ EmotionPrompt phrases — diminishing/negative returns on nano

---

## What still needs Adam (not researchable, founder/owner work)

**Character Bible v1** — one page:
- PA's name (currently no canonical name)
- Backstory: who PA is, why PA cares about Adam-and-his-users' job hunt
- 3 verbal tics (signature phrases or speech patterns)
- Reaction templates: when frustrated / when celebrated / when reset
- 1-2 signature emoji (whitelist)
- Code-switch policy (zh ↔ en)
- Length cap

Without this Bible, P9-Voice spawn = wasted cycles tuning prompts without an anchor.

---

## Sources (full list)

Top hits:
- SillyTavern Character Design — https://docs.sillytavern.app/usage/core-concepts/characterdesign/
- Character Card V2 Spec — https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
- Janitor AI Advanced Prompting 101 — https://help.janitorai.com/en/article/advanced-prompting-101-1ka4aon/
- EmotionPrompt — https://arxiv.org/abs/2307.11760
- Persona is a Double-edged Sword — https://arxiv.org/abs/2408.08631
- XiaoIce Design — https://arxiv.org/abs/1812.08989 / https://aclanthology.org/2020.cl-1.2.pdf
- Anti-Robotic AI Prompt — https://sagar-srivastava.medium.com/how-i-built-a-prompt-to-stop-ai-from-sounding-like-a-robot-d7147662e0c3
- Mental Wellness Prompts — https://github.com/joebwd/mental-wellness-prompts
- SODA dataset — https://github.com/skywalker023/sodaverse
- FED Dialog Eval — https://arxiv.org/abs/2006.12719
