# Milestone state — v1.1 Pre-Launch Hardening + Companion Brain

## Current Position

Phase: Not started (defining requirements → roadmap)
Plan: —
Status: Defining requirements
Last activity: 2026-04-27 — Milestone v1.1 started

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
- **Character Bible v1** — one-page anchor: PA name + backstory + 3 verbal tics + reaction templates + 1-2 signature emoji + code-switch policy + length cap. P9-Voice spawn blocked until Adam writes this.
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
