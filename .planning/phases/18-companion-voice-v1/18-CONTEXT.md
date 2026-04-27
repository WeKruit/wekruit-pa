# Phase 18: Companion Voice v1 (static base) — Context

**Gathered:** 2026-04-27
**Status:** Ready for planning
**Mode:** Auto-generated (Bible + research already in-bank from milestone-discuss)

<domain>
## Phase Boundary

Rewrite the PA system prompt so iMessage replies sound like a real friend (Claire / 小柯 per `CHARACTER-BIBLE-v1.md`), not a database citation. Foundation layer for all later voice work. Stay on `gpt-5.4-nano` (no model escalation — Adam-locked constraint).

In scope:
- New `system_prompt` rewrite using Snapchat MyAI skeleton (research-validated structure)
- `first_mes` voice anchor (highest-ROI single lever per SillyTavern docs)
- 3 `mes_example` few-shot dialogue turns demonstrating implicit memory ack (Tendera "facts as voice" pattern)
- Post-history voice reminder (50-100 tokens, injected just before user's latest turn)
- Eval rubric extended with 4 voice axes: `warmth_no_sycophancy`, `in_character_voice`, `no_robot_filler`, `length_appropriateness`
- Eval LLM-judge auto-fail criteria: zh + en filler blacklist
- 5+ companion-voice golden scenarios as anchor benchmarks
- Pairwise judge harness comparing new prompt vs current baseline

Out of scope (deferred to other phases):
- Adaptive mirror layer (Phase 19)
- Output normalization for markdown / UTM (Phase 20)
- Channel migration (Phase 21)
- Proactive check-in voice (Phase 22 will reuse this voice)
- Onboarding flow (Phase 23)
- Fine-tuning (post-milestone)
- Sonnet escalation (Adam-locked: NO)

</domain>

<decisions>
## Implementation Decisions

### Locked

1. **Stay on gpt-5.4-nano** — Adam-locked, validated by Round 1 research (SillyTavern + Janitor: small models bind to demonstrated patterns more than to model size).
2. **Static base only this phase** — dynamic mirroring (Phase 19) explicitly deferred. Phase 18 ships a working static voice that meets eval gates; Phase 19 layers on top.
3. **Negative instructions stay OUT of system prompt** — token-activation risk on small models. Filler blacklist goes in **eval LLM-judge auto-fail criteria** only, NOT in the prompt.
4. **`first_mes` + `mes_example` are the highest-ROI levers** — research consensus across SillyTavern docs (https://docs.sillytavern.app/usage/core-concepts/characterdesign/) and Janitor advanced prompting docs.
5. **Show, don't tell** — implicit ack pattern ("柠檬茶女孩 🍋") demonstrated in `mes_example`, NOT described in prose.
6. **Memory layer separation** — per-Tendera, per-user facts stay in mem0 retrieval, NEVER injected as bullet specs in system prompt.
7. **Code-switch policy** — user zh → PA zh; user en → PA en; user mix → mirror (mirror policy detail = Phase 19 scope; Phase 18 implements default zh / en branches only).
8. **`__PA_RESET__` orchestrator guard preserved** — voice change does NOT touch reset path.

### Claude's discretion (planner decides)

- Exact wording / cadence of `first_mes` (must reflect Bible v1: 1-2 sentences, deadpan, lowkey-warm, signature 🍋 or ☕ if natural)
- Selection of 3 `mes_example` few-shot turns (drawn from Bible reaction templates: emo / offer / reset / mid-JD)
- Post-history reminder phrasing (50-100 tokens, positive framing only)
- Pairwise eval judge prompt structure (research suggests bigger judge model OK since iteration-time only)
- File-level placement of new prompt (`packages/agent-registry/src/default-agent.ts` likely; verify in research step)
- Whether to ship the new prompt as a draft `pa_agents` row + dashboard publish flow, or hot-swap via env flag for staging

</decisions>

<code_context>
## Existing Code Insights

Codebase has the following shape (verify in plan-phase research):

- **Default agent system prompt source**: likely under `packages/agent-registry/src/` — need to confirm exact file. Phase 11.1 (persona card injection) added `buildPersonaCard` (in `@pa/memory`) which prepends a Firestore-fact persona card. Phase 18's new system prompt must compose with this card or replace its purpose deliberately.
- **Orchestrator turn entry**: `packages/pa-orchestrator/src/index.ts`. New post-history voice reminder injection point lives here (after history, before model call).
- **Eval harness**: `tests/scenarios/runner.mjs` + `tests/scenarios/judge.mjs` + scenarios in `tests/scenarios/scenarios/*.yaml`. Phase 14 LLM-as-judge support exists; this phase extends with 4 new axes.
- **Agents SDK runtime**: `packages/agent-runtime/src/openai-agents-adapter.ts`. The Phase 10.5 cutover wired Agents SDK + Responses API; voice change goes in via `agent.systemPrompt` field (not by changing the runtime adapter).
- **Persona card**: `packages/memory/src/persona-card.ts` — Phase 11.1 deterministic Firestore-fact card. Phase 18 may need to define how voice prompt and persona card compose (concatenation order, length budget).

</code_context>

<specifics>
## Specific Ideas

### Inputs to plan from
- `.planning/phases/18-companion-voice-v1/CHARACTER-BIBLE-v1.md` (Adam-approved, locked 2026-04-27)
- `.planning/phases/17-pre-launch-hardening/17-RESEARCH-companion-voice.md` (Round 1 framework)
- `.planning/phases/17-pre-launch-hardening/17-RESEARCH-raw-artifacts.md` (Round 2 raw artifacts: Snapchat MyAI verbatim prompt, Tendera diff, Meta filler-ban list, Anthropic Claude Soul, Discord Clyde)
- `.planning/REQUIREMENTS.md` (VOICE-01 through VOICE-10)
- Memory: `~/.claude/projects/-Users-adam-Desktop-WeKruit-wekruit-pa/memory/companion_voice_constraints.md`

### Voice prompt structure (target)

```
[system_prompt]
"You are Claire (小柯). [backstory from Bible]. You text like a real person..."
[concise + sparse-emoji rules from MyAI]

[first_mes]
"[Adam-approved opening line in Claire's voice, demonstrating cadence + signature emoji policy]"

[mes_example]
<START>
{{user}}: 我又被拒了 emo 中
{{char}}: 拒得快说明他们没准备好你. next.

<START>
{{user}}: 你能帮我看下这个 JD 吗
{{char}}: 发来. 给你测评一下.

<START>
{{user}}: 我喜欢喝柠檬茶
{{char}}: 柠檬茶女孩 🍋 行, 下次催简历的时候配你一杯.
```

### Eval scenarios to add (≥5)
- `eval-voice-memory-ack-zh.yaml` — user shares preference, PA must NOT respond with "好的我记住了"
- `eval-voice-emo-support-zh.yaml` — user vents, PA must respond with quiet support not pep talk
- `eval-voice-offer-celebration-zh.yaml` — user gets offer, PA must ack without emoji rain
- `eval-voice-mid-jd-roast-en.yaml` — user shares mid JD, PA can sass without sycophancy
- `eval-voice-reset-deadpan-zh.yaml` — `__PA_RESET__` flow must produce deadpan confirmation, no marketing copy
- `eval-voice-tech-deep-en.yaml` — tech-deep question allowed to go ≤5 sentences, still no markdown bullets

### Filler blacklist (for eval LLM-judge auto-fail, NOT for system prompt)

zh: `好的，我记住了 / 收到 / 没问题，我会记得 / 下次我会注意 / 已记录 / 让我帮你梳理一下 / 需要注意的是 / 这点很重要`

en: `It's important to / It's crucial to / Remember, / Keep in mind / That's a tough one / Sounds like a tricky situation / I'll remember that / Got it / Of course / I'd be happy to help`

### Rollback plan
- Add `PA_VOICE_V1_DISABLED=true` env flag → falls back to current system prompt
- Default agent has versioned `pa_agents` row — published default can be rolled back via existing Phase 5 publish/rollback mechanism

</specifics>

<deferred>
## Deferred Ideas

- Dynamic mirror (per-turn user-style match) → Phase 19
- Output normalizer (markdown / UTM strip / length cap) → Phase 20 (relevant: Phase 18 voice prompt MUST instruct "no markdown" via positive `mes_example` only — and Phase 20 acts as bottom-line guard)
- Voice for proactive turns → Phase 22 reuses Phase 18 prompt
- Bigger judge model investment (Sonnet judge during eval iteration) → Phase 18 plan can decide whether to use it; runtime stays on nano
- Fine-tuning / RFT → not until ≥10k human-validated turns exist (≥6 months out per research)

</deferred>
