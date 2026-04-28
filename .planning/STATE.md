---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: — Agent SDK Runtime + Job Companion
status: executing
last_updated: "2026-04-28T03:34:00.671Z"
last_activity: 2026-04-28
progress:
  total_phases: 23
  completed_phases: 12
  total_plans: 29
  completed_plans: 14
---

# Milestone state

## Active milestone: v1.2 — Voice 拟人化 + Eval Foundation (spawned 2026-04-27)

See [`MILESTONE-v1.2.md`](./MILESTONE-v1.2.md) and [`phases/24-voice-quality-baseline/24-CONTEXT.md`](./phases/24-voice-quality-baseline/24-CONTEXT.md).

**Status:** Ready to execute

**v1.1 carryover:** Phases 19, 22, 23 not started; deprioritized behind voice quality. Revive after v1.2 ships. Phase 21 (Sendblue) shipped 2026-04-27.

---

# Milestone state — v1.1 Pre-Launch Hardening + Companion Brain (carryover, partial ship)

**Canonical build plan (开干入口):** [`.planning/v1.1-EXECUTION-PLAN.md`](./v1.1-EXECUTION-PLAN.md) — 含依赖顺序、QA/LLM 多轮、入站安全接线、通道统一架构、Report 结构。P10 补充： [`.planning/v1.1-p10-northstar-security-channel.md`](./v1.1-p10-northstar-security-channel.md).

## Current Position

Phase: 24 (Voice Quality Baseline) — EXECUTING
Plan: 3 of 7
Status: Ready to execute
Last activity: 2026-04-28

## v1.1 Plan Commits (autonomous batch)

| Phase | Commit | Tasks |
|---|---|---|
| 18 Companion Voice v1 | `3820689` | 5 (1 wave) |
| 19 Adaptive Mirror | `2e1683a` | 6 (1 wave) |
| 20 Output Normalizer | `29c8bfb` | 2 (TDD) |
| 21 Sendblue Migration | `d4c1c8e` | 12 (3 checkpoints) |
| 22 Proactive Check-in | `f70ec2f` | 6 (1 wave) |
| 23 Closed Beta Onboarding | `72e2f33` | 5 (1 wave) |
| Bible v1 | `7cc1bfb` | locked |

## Execution dependency graph

```
Phase 18 (Voice v1)  ──┬─→ Phase 19 (Mirror)
                       ├─→ Phase 22 (Proactive) ←─ Phase 20 (Normalizer)
                       └─→ Phase 23 (Beta Onboarding)

Phase 20 (Normalizer)  — independent, parallelable with 18

Phase 21 (Sendblue)    — independent of voice; blocked on Adam contract Qs
                         (CHANNEL-08 gates production cutover, not code-landing)
```

## Adam's blocking decisions

1. **Sendblue contract Qs (4)** — block Phase 21 production cutover (NOT code landing — code can ship behind `PA_CHANNEL_LEGACY=1` flag):
   - Apple ID ownership (Sendblue's vs operator's)
   - SLA on number re-provisioning if Apple flags a line
   - Outbound rate limit numbers
   - GDPR / data residency posture
2. **GCP Cloud Scheduler one-time creation** — Phase 22 user_setup human step.
3. **Webhook signing secret provisioning** — Phase 21 Task 10 checkpoint (Adam provides via `firebase functions:secrets:set`).

## Recommended execution order

1. `/clear` then `/gsd:execute-phase 18` (Bible locked, plan ready, no Adam blocker)
2. After 18 ships → parallel: `/gsd:execute-phase 20` (independent, ≤1 day) and `/gsd:execute-phase 23` (depends on 18 voice)
3. After 18 + 20 ship → `/gsd:execute-phase 22` (proactive needs voice + normalizer)
4. After 18 ships → `/gsd:execute-phase 19` (adaptive mirror layered on static base)
5. Whenever Adam answers Sendblue Qs + provisions sandbox → `/gsd:execute-phase 21`

## Milestone goal

Closed-beta launchable (≤20 hand-picked users) within 3 weeks. Fix robotic companion voice via prompt structure on gpt-5.4-nano (no Sonnet escalation), migrate channel layer to Sendblue, close output-normalization + safety gaps, and revive proactive check-in.

## Accumulated Context (carried from v1.0)

### v1.0 baseline shipped

- Phase 1-9: Broker correctness + Dashboard shell + Memory evol + Scheduler + Phase 2/3 production hardening
- Phase 10: Agents SDK current-info connector (closed 2026-04-26)
- Phase 10.5: Agents SDK runtime cutover — default agent runs OpenAI gpt-5.4-nano via Responses API; webSearchTool attached; SiliconFlow demoted to env-gated fallback (closed 2026-04-26)
- Phase 11.1: Persona card injection (closed 2026-04-27); Phase 11.3 mem0UserId migration not started
- Phase 13: WeKruit matching connector (degraded mode contract; `PA_MATCHING_URL` not yet wired)
- Phase 14: Companion eval harness (LLM-as-judge + cost ceiling, 23 scenarios pass)
- Phase 15: Chunked typing simulation (kill switch armed, default disabled)
- Phase 16/17 baseline: worker durable cursor + auto-catchup + allowlist fail-closed (inbound + outbound) — landed 2026-04-27

### v1.1 research already in-bank

- `.planning/phases/17-pre-launch-hardening/17-CONTEXT.md` — milestone scope + Sendblue migration design + Output Normalizer design + Proactive Check-in plumbing
- `.planning/phases/17-pre-launch-hardening/17-RESEARCH-companion-voice.md` — Round 1 frameworks (SillyTavern V2, Ali:Chat, EmotionPrompt caveats on small models)
- `.planning/phases/17-pre-launch-hardening/17-RESEARCH-raw-artifacts.md` — Round 2 raw artifacts (Snapchat MyAI prompt verbatim, Tendera "facts as voice" diff, Meta filler-ban list, Anthropic Claude Soul, Discord Clyde sass, zh+en slang lexicons, Anthropic anti-overcaution checklist)

### Locked architecture decisions

- ONE agent runtime = OpenAI Agents SDK; default LLM = gpt-5.4-nano via Responses API
- SiliconFlow demoted to env-gated fallback (`PA_AGENT_LLM_PROVIDER=siliconflow`)
- Mem0/Qdrant remains memory empowerment layer (Mem0 LLM/embedder still SiliconFlow Qwen + bge-m3)
- Hosted tools attach via SDK `webSearchTool` when `agent.toolPolicy === "allowlist"`
- `__PA_RESET__` stays as orchestrator-level guard, not a tool
- Sendblue is pure transport (triple-verified) — agent runtime, memory, persona stay with us

### Adam-locked v1.1 constraints

- No model escalation (no Sonnet); voice fix at prompt + persona + eval layer only
- No fine-tuning (no anchor data yet)
- No negative-instruction blacklists in system prompt — go in eval LLM-judge auto-fail criteria only
- Keep Mem0/Qdrant + Memory Admin
- Closed-beta tolerates iMessage Apple-ID gray zone for ≤20 users; Sendblue migration before public launch

### Open Adam decisions (pre-Phase-18 spawn)

- **Character Bible v1** — **locked** in `CHARACTER-BIBLE-v1.md` (Claire/小柯). Edits need Adam sign-off.
- **Sendblue contract** — confirm 4 contract questions before signing: Apple ID ownership, SLA on number re-provisioning, outbound rate limit, GDPR posture.

### Known gaps carried forward

- `PA_MATCHING_URL` unset → wekruit-matching connector in degraded mode (Phase 13 follow-up)
- Phase 11.3 mem0UserId authoritative migration not started
- Dashboard production build emits non-fatal large chunk warning
- Default PA profile path returns `Unsupported runtime profile "personal-assistant-default"` in ATM
- `gpt5.4nano` slug bug still latent (correct slug `gpt-5.4-nano`)

### Public launch gate (post-v1.1, separate cycle)

- B4 secrets to GCP Secret Manager
- B1 Apple ID risk fully resolved (Sendblue or Business Chat)
- GDPR/CCPA delete API + abuse events full producers
- Always-on Mac mini (or remove via Sendblue migration)
