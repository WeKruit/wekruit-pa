# Jobless / PA Platform

Monorepo: Mac **Photon iMessage worker** (deprecating to Sendblue) + Firestore **`pa_*`** + **PA Console** (Vite, `wekruit-pa.web.app`). Auth: Google; Firestore rules: `@wekruit.com` + allowlisted Gmail (see `config/firebase/firestore.rules`).

## Current Milestone: v1.1 Pre-Launch Hardening + Companion Brain

**Execution plan (build order, QA, security wiring, channel architecture, report):** [`.planning/v1.1-EXECUTION-PLAN.md`](./v1.1-EXECUTION-PLAN.md).

**Goal:** Take WeKruit PA from alpha-grade demo to closed-beta launchable (≤20 hand-picked users) within 3 weeks. Fix the "robotic" companion voice via prompt structure (no model escalation), replace single-host iMessage worker with hosted transport (Sendblue), close safety/normalization gaps, and revive proactive check-in.

**Target features:**
- **Companion Voice v1** — system prompt rewrite (Snapchat MyAI skeleton + Tendera "facts as voice" + Meta filler-ban eval), 5-axis eval rubric, stays on gpt-5.4-nano
- **Adaptive Mirror Layer** — per-turn user-style analyzer (mirror register/language ratio/emoji freq) + dynamic persona injection + long-term mem0 preference learning
- **Output Normalizer** — channel-agnostic post-LLM normalization (strip markdown, strip UTM tracking, length cap)
- **Sendblue Channel Migration** — webhook handler in CF + REST send + deprecate `apps/macos-imessage-worker` (eliminates single-host risk + Apple-ID ToS exposure)
- **Proactive Check-in** — dashboard trigger UI + `pa_scheduled_jobs` cron + orchestrator proactive-turn path (revived from skipped Phase 12)
- **Closed Beta Onboarding** — 20 hand-picked users flow + `pa_abuse_events` producers wired

**Key constraints (Adam-locked):**
- No model escalation (no Sonnet); voice fix via prompt structure on nano
- No fine-tuning (no anchor data yet)
- No negative-instruction blacklists in system prompt (small-model token activation risk); blacklists go in eval LLM-judge auto-fail criteria only
- Keep Mem0/Qdrant + Memory Admin (don't replace)
- iMessage Apple-ID violation tolerated for ≤20 closed beta; Sendblue migration before public launch

**Research saved:**
- `.planning/phases/17-pre-launch-hardening/17-CONTEXT.md`
- `.planning/phases/17-pre-launch-hardening/17-RESEARCH-companion-voice.md`
- `.planning/phases/17-pre-launch-hardening/17-RESEARCH-raw-artifacts.md`

## Previous Milestone (v1.0): Agent SDK Runtime + Job Companion (foundational)

**Goal:** Turn the working local iMessage E2E into an agentic job-search companion: OpenAI Agents SDK as the runtime spine, WeKruit-owned identity/memory/audit controls, safe live current-info retrieval, and proactive recruiter-style follow-up.

The real iMessage path is green: inbound creates durable `pa_inbound_events`, orchestrator completes turns, transcript writes, `pa_outbound` sends, reset works, and cross-turn memory recall has been validated. Phase 2 harness now uses broker injection with `suppressOutbound` so production scenarios do not send real iMessages. Phase 3 Memory Admin is live in PA Console.

Current-info is in transition: stale “recent/latest” questions no longer fall through to old model knowledge, and `main` is moving the `current-info` connector from hand-written Responses API fetches to OpenAI Agents SDK hosted `web_search`. Production enablement uses one general OpenAI agent/tool secret, `PA_OPENAI_AGENT_API_KEY`, plus a functions deploy and live harness verification.

### Current milestone targets

- **OpenAI Agents SDK becomes the runtime spine** for OpenAI-native tools and future agent workflows. Avoid long-lived hand-written Responses fetch wrappers when the Agents SDK exposes the hosted tool directly.
- **One OpenAI agent/tool secret**: use `PA_OPENAI_AGENT_API_KEY` for official OpenAI Agents SDK hosted tools. Do not keep a current-info-specific key name.
- **WeKruit keeps product control**: identity, memory, scheduling, outbound policy, audit, dashboard, and user consent stay in Firestore/PA Console, with context injected into agent turns instead of outsourced to opaque ChatGPT product memory.
- **Mem0/Qdrant + Memory Admin stay**: semantic recall remains inspectable/deletable in PA Console. OpenAI file/vector search can be evaluated later as another provider, not as an immediate replacement.
- **Job companion direction**: PA should become a personal job-search companion/recruiter presence that periodically asks about projects/job-search status and proactively notifies users about matched roles when allowed.

### Product direction

- **iMessage worker remains a channel adapter**: no agent brain and no duplicate transcript writes for broker-managed outbound.
- **Firestore remains the control plane**: durable queues, transcripts, agent configs, operation state, persona/evolution facts, and audit trails.
- **SiliconFlow can remain the OpenAI-compatible model path**, but OpenAI-native hosted tools and agent workflows use OpenAI Agents SDK through `PA_OPENAI_AGENT_API_KEY`.
- **Mem0 is optional semantic recall**: self-hosting is a future capability, not a hard dependency for core replies.
- **Dashboard must become an operator product**, not a raw Firestore table viewer.
- **Current-info must fail closed**: if realtime search is unavailable, PA says it cannot reliably answer rather than giving stale movies/news/weather/prices.
- **Proactive outreach must be permissioned**: scheduled nudges, job-match notifications, and recruiter-style follow-up require cooldowns, audit events, and a clear outbound policy.

See `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`.

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

*Last updated: 2026-04-27 — Milestone v1.1 started.*
