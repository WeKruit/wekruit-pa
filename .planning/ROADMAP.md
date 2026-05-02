# Roadmap

This roadmap is intentionally numeric so GSD phase tooling can discover and execute it.

## Milestone v1.0 — Agent SDK Runtime + Job Companion (foundational)

| # | Phase | Goal | Requirements | Status |
|---|-------|------|--------------|--------|
| 1 | Broker correctness + echo suppression | Make the green iMessage E2E path reliable and non-polluting. | P0.1, P0.4 | Complete |
| 2 | Reliability, safety, and tests | Add CI-safe coverage for rate limits, broker lifecycle, orchestrator paths, and worker behavior. | P0.1, P1 | Complete |
| 3 | Dashboard shell + design system | Replace the raw admin feel with a coherent operator shell and reusable UI primitives. | P0.2, P1 | Complete |
| 4 | Operations and conversation workbench | Give operators a useful conversation/queue/debug workflow without tailing logs. | P0.2, P0.4 | Complete |
| 5 | Agent registry + persona controls | Upgrade agent management from row editing to versioned/published agent and persona control. | P0.3 | Complete |
| 6 | Memory evol map + Mem0 compatibility | Add Firestore persona/evolution memory and support Mem0 self-host compatibility as optional recall. | P0.5 | Complete |
| 7 | Scheduler and platform runtime | Add durable scheduled jobs, stuck job recovery, retry/backoff, and runtime heartbeats. | P0.1, P1 | Complete |
| 8 | Reviews, polish, and ship readiness | Run engineering/design reviews, close gaps, and produce final verification evidence. | P1 | Complete |
| 9 | Phase 2/3 production hardening | Make production verification repeatable and expose semantic memory safely in dashboard. | P0.1, P0.2, P0.4, P0.5 | Mostly complete |
| 10 | Agents SDK current-info connector | Answer recent/latest questions through Agents SDK hosted web search without stale model guesses. | P0.6, P0.7 | Complete (connector path only) |
| 10.5 | Agents SDK runtime cutover | Make Agents SDK the only agent runtime; default agent uses Responses API + gpt-5.4-nano. | P0.6, P0.7 | Complete |
| 11 | Persona + identity/memory injection | Restore persona facts, resolve memory identity semantics, and inject PA-owned context into agent turns. | P0.3, P0.5, P0.7, P0.9 | 11.1 complete; 11.3 not started |
| 12 | Job companion scheduled outreach | (Skipped — revived as Phase 22 in v1.1 with companion-voice integration.) | P0.1, P0.8 | Skipped → Phase 22 |
| 13 | Job matching connector path | Add an auditable platform-managed path for matched-role notifications. | P0.4, P0.8 | Complete (degraded mode) |
| 14 | Companion eval + harness expansion | Add scenario/eval coverage for current-info live search, persona, proactive outreach, and match rationale. | P0.6, P0.7, P0.8, P1 | Complete |
| 15 | Typing indicator / delivery feel | Improve iMessage delivery feel using Photon typing if available or chunk/delay simulation. | P1 | Complete (kill-switch armed) |
| 16 | Worker durable cursor + auto-catchup | Persist last-processed iMessage rowId in Firestore; offline → online recovery. | (v1.0 hardening) | Complete 2026-04-27 |
| 17 | Allowlist fail-closed (inbound + outbound) | Default-deny when `IMESSAGE_DM_ALLOWLIST` unset; gate inbound + outbound; audit log. | (v1.0 hardening) | Complete 2026-04-27 |

## Milestone v1.1 — Pre-Launch Hardening + Companion Brain

**Goal:** Closed-beta launchable (≤20 hand-picked users) within 3 weeks.

| # | Phase | Goal | Requirements | Status |
|---|-------|------|--------------|--------|
| 18 | Companion Voice v1 (static base) | Rewrite system prompt using Snapchat MyAI skeleton + Tendera "facts as voice" + first_mes/mes_example anchors; stays on gpt-5.4-nano. Eval rubric extended with 4 voice axes. | VOICE-01..VOICE-10 | Not started |
| 19 | Adaptive Mirror Layer | 1/1 | Complete   | 2026-04-28 |
| 20 | Output Normalizer | Channel-agnostic post-LLM normalization (strip markdown, UTM, length cap) at orchestrator exit. Eval gains 5th axis `iMessage_render_safe`. | NORM-01..NORM-08 | Not started |
| 21 | Sendblue Channel Migration | CF webhook handler + REST send + allowlist moves to webhook handler; deprecate macos-imessage-worker. Eliminates single-host risk + Apple-ID exposure. | CHANNEL-01..CHANNEL-09 | Not started |
| 22 | Proactive Check-in (revived from skipped Phase 12) | 1/1 | Complete   | 2026-04-28 |
| 23 | Closed Beta Onboarding + Safety | Onboarding flow for 20 hand-picked users; abuse signal producers wired (rate-limit / injection / allowlist-deny → `pa_abuse_events`); allowlist UI in dashboard. | BETA-01..BETA-05 | Not started |

## Milestone v1.2 — Voice 拟人化 (Anti-油腻) + Eval Foundation

**Goal:** Eliminate coach-mode / 油腻 voice. Establish reusable eval framework. Day-1 internet 网感 corpus. Defer per-user self-evolution to v1.3.

**Spawned:** 2026-04-27 after Phase 21 Sendblue cutover proved channel works; voice quality became sole blocker to opening closed beta beyond internal testers.

**Estimate:** 3 dev days + ~3 hours Adam HITL.

| # | Phase | Goal | Status |
|---|-------|------|--------|
| 24 | Voice Quality Baseline | Bible v6/v7 + few-shot relocate + Qwen rewriter v2 + DeepEval foundation. 5/7 plans shipped (Bible v7.0 caveman architecture, headhunter playbook, sweep admin token). | 5/7 In Progress |
| 24.5 | Feature Flag Infra (cross-cutting) | Firestore `pa_feature_flags` + 30s TTL cache + dashboard CRUD + audit + perUser scope. Replaces env-var 散点. P10 cut 2026-04-28. | Planned |
| 25 | Voice Review Dashboard | `/voice` page + `pa_voice_reviews` collection + 1-5⭐ + tags + comment + 一键 eval rerun + diff vs baseline. **Data producer for v1.3 self-evolve.** | Planned |

**Documents:**
- `MILESTONE-v1.2.md` — milestone-level decisions, web-verified corpus, success criteria
- `v1.2-p10-strategic-cut.md` — P10 strategic cut (2026-04-28) for Productionize milestone
- `phases/24-voice-quality-baseline/24-CONTEXT.md` — full Phase 24 spec
- `phases/24.5-feature-flag-infra/` — to be created by /gsd:autonomous plan-phase
- `phases/25-voice-review-dashboard/` — to be created

## Milestone v1.3 — Productionize (公测 gate + Self-Evolve Loop 闭环)

**Goal:** 把 v1.2 voice baseline + review dashboard 推到公测稳态. 闭环 self-evolve loop. 关掉所有 P0/P1/P2 ops debt.

**Spawned:** 2026-04-28 by P10 strategic cut.

**Estimate:** 10 dev-day execution + 2 weeks soak before self-evolve cron 开闸.

| # | Phase | Goal | Status |
|---|-------|------|--------|
| 26 | Productionize P0 (公测 hard gate) | per-user rate-limit (flag-gated via 24.5) + Sendblue Free 配额监控 + Cloud Logging dashboard + cost alert + agent-registry version pin + 一键 rollback | Planned |
| 27 | Productionize P1+P2 + Self-Evolve Cron | Qwen circuit breaker + Qdrant↔Firestore drift cron + 5×CF /health + SLO+error budget + self-evolve cron (daily transcript→judge→cluster→Bible patch PR→eval gate). Absorbs old Phase 25 Voice Self-Evolve spec. | Planned (gated) |
| 28 | Multi-Turn LLM-vs-LLM Dialog Sim Eval | 5 user personas × N-round simulator × ConversationalGEval (voice consistency / mode switch / no probe regression / 油腻 absence / first-person opener density / memory scaffolding) + dashboard tab + label-gated CI. Orthogonal to Phase 27. | Planned (no gate) |
| 29 | Agent Handbook | Bible-as-data — section-structured handbook with versioning, dashboard editor, audit, rollback. Replaces inline systemPrompt. | Planned |
| 30 | Downstream Eval Connector | Per-turn eval LLM triggers external service (mock interview push, levels.fyi link). Trigger CRUD + cooldown + HMAC payload. | Planned |
| 31 | Upstream Event Connector | External event → proactive Claire message. HMAC inbound, template lookup, rate-limit, outbound enqueue. | Planned |
| 32 | Dashboard IA Reorg + Stress Harness + Playbooks/Personas CRUD | Neighbor-agent UX audit P0/P1 fix-pack: 5-category sidebar, delete Playground+Platform, demote Operations, rebuild Conversations/UserDetail/Voice/Flags-history; Artillery stress harness; soul.md-style Playbooks + Personas CRUD; paSendblueOutbox repair. 4 parallel waves. | Planned |

**v1.3 Public Launch Gate:**
- [ ] Phase 24.5 Feature Flag — 4 env-var 收编完成
- [ ] Phase 25 Voice Review Dashboard — Adam 评分 ≥50 turn 跑通
- [ ] Phase 26 P0 — 4 项全绿, 公测 gate PASS
- [ ] Phase 27 P1+P2 — SLO 仪表盘上线, error budget 定义
- [ ] Self-evolve cron — 仅在 P26 stable 2 周 + ≥200 reviews 后 `selfEvolveEnabled` flag 开闸

**Documents:**
- `v1.2-p10-strategic-cut.md` — strategic cut + P9 编制 + 风险 + 不做清单
- `phases/26-productionize-p0/` — to be created
- `phases/27-productionize-p1-selfevolve/` — to be created (absorbs old `phases/25-voice-self-evolve/25-CONTEXT.md`)
- `phases/28-multi-turn-sim-eval/` — Phase 28 spawn (orthogonal to 27, no hard gate)

## Phase 1: Broker correctness + echo suppression

**Goal:** Make the green iMessage E2E path reliable and non-polluting.
Requirements: P0.1, P0.4
**Success Criteria**:
1. Broker-managed outbound `out-imessage-in-*` does not create duplicate `role=user` transcript rows.
2. Worker tests prove broker-managed outbound is not appended as operator/user transcript.
3. `npm run build`, worker tests, and typecheck pass.
4. Manual iMessage test shows inbound user + assistant reply only, no assistant-as-user echo.

## Phase 2: Reliability, safety, and tests

**Goal:** Add automated coverage and close lifecycle correctness gaps that do not require a real Mac.
Requirements: P0.1, P1
**Success Criteria**:
1. Broker tests cover inbound idempotency, claim, fail, complete, dead-letter, and error clearing.
2. Safety tests cover rate limit allow/block, audit events, and abuse events.
3. Orchestrator tests cover happy path, no-key fallback, safety block, duplicate idempotency, and connector allow/deny.
4. Outbound stuck-job and allowlist failure behavior is explicit and tested.

## Phase 3: Dashboard shell + design system

**Goal:** Create a product-grade operator shell with shared components instead of page-local raw tables.
Requirements: P0.2, P1
**Success Criteria**:
1. App has responsive shell, active navigation, page headers, status badges, cards, data table, empty/error/loading states.
2. Overview route summarizes worker/orchestrator health, recent failures, queue counts, and next actions.
3. UI copy explains operator actions in product language rather than raw collection language.
4. `gstack-design-review` or equivalent visual audit is run and findings are captured.

## Phase 4: Operations and conversation workbench

**Goal:** Make a single conversation debuggable and manageable from the UI.
Requirements: P0.2, P0.4
**Success Criteria**:
1. Conversation list supports search/filter and shows latest message, active agent, and last error.
2. Conversation detail shows transcript, turns, outbound, connector calls, audit/safety, and memory events in linked sections.
3. Operations has tabs/filters/detail view and safe retry/dead-letter with confirmation and reason capture.
4. UI smoke tests cover route rendering and key action wiring.

## Phase 5: Agent registry + persona controls

**Goal:** Make agents manageable as versioned runtime configs instead of fragile Firestore rows.
Requirements: P0.3
**Success Criteria**:
1. Agent default uniqueness is enforced.
2. Agents support draft/published version metadata and rollback/audit.
3. Model field supports provider validation and does not switch live default to `gpt-5.4-nano` without a passing runtime probe.
4. Persona controls separate tone/style/boundaries/goals from freeform system prompt.

## Phase 6: Memory evol map + Mem0 compatibility

**Goal:** Add auditable personality memory without making Mem0 a hard dependency.
Requirements: P0.5
**Success Criteria**:
1. Firestore schemas/constants exist for memory profiles, facts, evolution events, and surprise events.
2. Prompt context can include a deterministic persona card from confirmed Firestore facts.
3. Mem0 supports cloud and OSS/self-host API modes behind env configuration.
4. Surprise protocol is opt-in, cooldown-bound, sensitivity-aware, and fully logged.

## Phase 7: Scheduler and platform runtime

**Goal:** Add durable runtime mechanics for delayed work, retries, and operational health.
Requirements: P0.1, P1
**Success Criteria**:
1. Scheduled jobs support `dueAt`, status, attempt count, max attempts, and backoff.
2. Inbound/outbound stuck processing jobs can be reclaimed or surfaced.
3. Worker/orchestrator heartbeat data is visible in Operations/Overview.
4. Tests cover retry/backoff and stuck-job recovery.

## Phase 8: Reviews, polish, and ship readiness

**Goal:** Finish with engineering, UI, and verification evidence.
Requirements: P1
**Success Criteria**:
1. `gstack-plan-eng-review` or equivalent engineering review is run against the plan/work.
2. `gstack-design-review` or equivalent visual review is run against the live dashboard.
3. `gsd-review` or external review is run for high-risk phase plans.
4. Final build/typecheck/test/manual E2E evidence is captured, and remaining gaps are documented.

## Phase 9: Phase 2/3 production hardening

**Goal:** Make the PA production path verifiable without manual iMessage spam and expose semantic memory safely.
Requirements: P0.1, P0.2, P0.4, P0.5
**Status:** Mostly complete.
**Success Criteria**:
1. Scenario harness injects broker events and defaults to `suppressOutbound`.
2. Runner verifies no accidental `pa_outbound` rows for harness events.
3. Recall, reset, multilingual, and current-info boundary scenarios exist.
4. Memory Admin dashboard can list/search/delete Qdrant semantic memory and clear a user only after explicit operator action.
5. Overview separates pending/running from historical failures to avoid false “waiting” alarms.

## Phase 10: Agents SDK current-info connector

**Goal:** Let PA answer “recent/latest/today” external information questions through OpenAI Agents SDK hosted `web_search` while retaining fail-closed behavior.
Requirements: P0.6, P0.7
**Status:** In progress.
**Success Criteria**:
1. `current-info` connector uses `@openai/agents` hosted `web_search`, not a hand-written Responses fetch wrapper.
2. Orchestrator invokes current-info before LLM stale-answer path.
3. Connector attempts are visible in `pa_tool_calls` and audit events.
4. Missing or failing connector falls back to boundary reply.
5. Production functions bind `PA_OPENAI_AGENT_API_KEY`, deploy on Node 22, and pass current-info production harness with `pa_outbound=0`.

## Phase 11: Persona + identity/memory injection

**Goal:** Restore persona facts, resolve memory identity semantics, and inject PA-owned identity/memory context into agent turns.
Requirements: P0.3, P0.5, P0.7, P0.9
**Status:** Not started.
**Success Criteria**:
1. Firestore persona facts are injected into runtime prompt again.
2. `mem0UserId` advisory regression is resolved or explicitly removed.
3. Agent turns receive identity and memory context from WeKruit stores, not opaque ChatGPT product memory.
4. Persona/human-feel changes are evaluated through scenarios rather than prompt guessing.

## Phase 12: Job companion scheduled outreach

**Goal:** Add permissioned recruiter-style follow-up for recent projects and job-search status.
Requirements: P0.1, P0.8
**Status:** Not started.
**Success Criteria**:
1. Scheduled outreach jobs can ask about recent projects/job-search status with cooldowns and max attempts.
2. Outbound policy blocks proactive messages without required user/session consent state.
3. Every proactive outreach has audit context visible in dashboard.

## Phase 13: Job matching connector path

**Goal:** Add a platform-managed path for matched-role notifications.
Requirements: P0.4, P0.8
**Status:** Not started.
**Success Criteria**:
1. Matching connector input/output schemas include role source, match rationale, and user fit facts.
2. Matched-role notifications require auditable connector results before outbound enqueue.
3. Dashboard exposes why a match notification was sent or suppressed.

## Phase 14: Companion eval + harness expansion

**Goal:** Make current-info, persona, proactive outreach, and match rationale testable before broad dogfood.
Requirements: P0.6, P0.7, P0.8, P1
**Status:** Not started.
**Success Criteria**:
1. Live current-info scenario verifies sourced answers when `PA_OPENAI_AGENT_API_KEY` is configured.
2. Boundary scenario still verifies fail-closed behavior when the hosted tool is unavailable.
3. Persona and proactive outreach scenarios verify no accidental outbound in harness mode.

## Phase 15: Typing indicator / delivery feel

**Goal:** Improve iMessage perceived responsiveness.
Requirements: P1
**Status:** Complete (kill-switch armed, default disabled — to be deprecated in Phase 21 in favor of Sendblue native typing API).
**Success Criteria**:
1. Photon typing support is researched.
2. If true typing is unavailable, chunked message + delay behavior is implemented without duplicate outbound or harness leakage.

---

# Milestone v1.1 — Pre-Launch Hardening + Companion Brain

## Phase 18: Companion Voice v1 (static base)

**Goal:** Rewrite the PA system prompt so iMessage replies sound like a real friend, not a database citation. Stay on gpt-5.4-nano (no model escalation). Foundation for all later voice work.
Requirements: VOICE-01, VOICE-02, VOICE-03, VOICE-04, VOICE-05, VOICE-06, VOICE-07, VOICE-08, VOICE-09, VOICE-10
**Pre-req (Adam owner):** Character Bible v1 must exist before P9-Voice spawn (PA name + backstory + 3 verbal tics + reaction templates + signature emoji + code-switch policy + length cap). [DONE 2026-04-27 — `CHARACTER-BIBLE-v1.md` locked]
**Plans:** 1 plan

Plans:
- [ ] 18-PLAN.md — Voice v1 system prompt rewrite + post-history reminder + 4-axis eval + 6 golden scenarios + pairwise judge harness

**Status:** Planned 2026-04-27 — not started.
**Success Criteria**:
1. System prompt structurally follows Snapchat MyAI skeleton (verbatim research artifact saved in `.planning/phases/17-pre-launch-hardening/17-RESEARCH-raw-artifacts.md`); no monologue, ≤2 sentences default, sparse emoji, no AI-self-identification.
2. `first_mes` voice anchor + 3 `mes_example` few-shot turns shipped, demonstrating implicit memory ack ("柠檬茶女孩 🍋" pattern) per Tendera "facts as voice" rule.
3. Post-history voice reminder (50-100 tokens) injected before user's latest turn so voice survives long context.
4. Eval LLM-judge auto-fail criteria include zh + en filler blacklist (NOT in system prompt — token activation risk).
5. Eval rubric measures 4 axes (warmth_no_sycophancy, in_character_voice, no_robot_filler, length_appropriateness); ≥2.4/3 average across 5+ companion-voice golden scenarios.
6. Pairwise judge confirms new voice beats current-prompt baseline ≥70% on golden scenarios.

## Phase 19: Adaptive Mirror Layer

**Goal:** PA adapts register / language ratio / emoji frequency / length to mirror the user per Meta AI WhatsApp pattern. Layered on top of Phase 18 static base (Phase 18 ships first).
Requirements: ADAPT-01, ADAPT-02, ADAPT-03, ADAPT-04, ADAPT-05
**Status:** Not started.
**Success Criteria**:
1. Per-turn analyzer extracts user style features (register score 0-1, zh/en char ratio, emoji freq, avg sentence length) from last 3-5 turns.
2. Dynamic mirror snippet injected post-history each turn ("user is currently using slangy zh-en mix; match that").
3. Long-term style preferences accumulate in mem0; persona card extension re-injects them next session.
4. `PA_VOICE_MIRROR_DISABLED=true` rollback flag honored (system falls back to Phase 18 static voice).
5. E2E scenario: turn 1 formal user → PA formal; turn 3 slangy user → PA slangy; mem0 records preference shift.

## Phase 20: Output Normalizer

**Goal:** Strip markdown, UTM tracking, and over-length output at orchestrator exit so iMessage doesn't render `**bold**` as literal asterisks. Channel-agnostic.
Requirements: NORM-01, NORM-02, NORM-03, NORM-04, NORM-05, NORM-06, NORM-07, NORM-08
**Status:** Not started.
**Success Criteria**:
1. New module `packages/pa-orchestrator/src/output-normalizer.ts` runs on every outbound at orchestrator exit (before outbox enqueue).
2. Strips markdown emphasis, converts links to plain text, strips `?utm_*` params, normalizes list markers to `· `.
3. Length cap (>600 chars) triggers chunk-split (reuse Phase 15 chunker logic) or graceful truncate.
4. Eval rubric gains 5th axis `iMessage_render_safe`; auto-fails on regex match `\*\*.+?\*\*` or `\[.+?\]\(.+?\)`.
5. Unit tests cover 8+ edge cases: mixed markdown, UTM params, code blocks, links, nested emphasis, very long input, empty input, all-Chinese input.

## Phase 21: Sendblue Channel Migration

**Goal:** Replace `apps/macos-imessage-worker/` with Sendblue hosted iMessage transport. Eliminates single-host availability risk + Apple-ID ToS exposure. ≈$100/mo per dedicated line.
Requirements: CHANNEL-01, CHANNEL-02, CHANNEL-03, CHANNEL-04, CHANNEL-05, CHANNEL-06, CHANNEL-07, CHANNEL-08, CHANNEL-09
**Pre-req (Adam owner):** Sendblue contract questions answered (Apple ID ownership, SLA on number re-provisioning, outbound rate limit, GDPR/data residency).
**Status:** Not started.
**Success Criteria**:
1. New CF endpoint `paSendblueWebhook` receives 4 webhook events (`receive`, `outbound`, `typing_indicator`, `line_blocked`); HMAC verified.
2. Webhook creates `pa_inbound_events` keyed by Sendblue `message_handle` (replaces `imessage-in-${rowId}`).
3. Allowlist gate enforced in webhook handler; non-allowlisted `from_number` returns 200 OK silently with audit log.
4. Outbox listener replaced with CF that POSTs to Sendblue REST `api.sendblue.co/api/send-message`.
5. Phase 15 chunked typing simulation deprecated; Sendblue native `typing_indicator` API used instead.
6. `apps/macos-imessage-worker/` behind `PA_CHANNEL_LEGACY=1` flag for one milestone, then removed.
7. Real Sendblue sandbox round-trip smoke <30s p95 (webhook → orchestrator → REST send → iMessage delivery).

**Plans:** 1/1 plans complete

Plans:
- [ ] 21-01-PLAN.md — paSendblueWebhook + paSendblueOutbox CF + allowlist port + secret manager + chunker dormancy + cutover runbook

## Phase 22: Proactive Check-in (revived from skipped Phase 12)

**Goal:** PA reaches out proactively based on user-defined triggers (time anchor / silence anchor / application follow-up). Trigger-based, opt-in, NOT cron-based broadcast.
Requirements: PROACTIVE-01, PROACTIVE-02, PROACTIVE-03, PROACTIVE-04, PROACTIVE-05, PROACTIVE-06, PROACTIVE-07
**Hard dependency:** Phase 18 must ship before Phase 22 — proactive turn must use Voice v1, not utility-tool voice.
**Status:** Not started.
**Success Criteria**:
1. Dashboard `/triggers` page supports CRUD for user-owned triggers with 3 types.
2. `pa_scheduled_jobs` schema has `userId`, `triggerType`, `nextFireAt`, `recurrence`, `context`, `status` fields.
3. New CF `paProactiveSweep` (Cloud Scheduler 1-min cron) dispatches due triggers to orchestrator.
4. Orchestrator proactive-turn path injects synthetic system input ("trigger fired: X"); uses Voice v1 prompt; output normalized.
5. Idempotency: same trigger × fireWindow doesn't double-send.
6. User can cancel triggers via iMessage NLU ("停止提醒" / "stop reminders"); orchestrator detects + updates trigger status.
7. E2E scenario test for each of 3 trigger types.

**Plans:** 1/1 plans complete
- [x] 22-PLAN.md — pa_scheduled_jobs schema + paProactiveSweep CF + /triggers dashboard + orchestrator proactive turn (Voice v1 reuse) + cancellation NLU + 3 E2E trigger scenarios

## Phase 23: Closed Beta Onboarding + Safety

**Goal:** First-class onboarding for ≤20 hand-picked closed-beta users. Wire the abuse signal producers that have been schema-only since v1.0.
Requirements: BETA-01, BETA-02, BETA-03, BETA-04, BETA-05
**Status:** Not started.
**Success Criteria**:
1. First-contact PA flow uses Voice v1 first_mes; asks 1-2 grounding questions; sets up mem0 partition.
2. `pa_abuse_events` producers wired at 3 points: rate-limit-trip, prompt-injection-detect, allowlist-deny.
3. Dashboard abuse panel surfaces last 50 abuse events with filter by type.
4. Allowlist UI in dashboard — operator adds/removes beta participants without editing `.env`.
5. Beta runbook (one-page) covers onboarding script + escalation contact + kill switch instructions.

---

# Milestone v1.2 — Voice 拟人化 (Anti-油腻) + Eval Foundation

## Phase 24: Voice Quality Baseline

**Goal:** Eliminate coach-mode / 油腻 voice via prompt structure + few-shot relocation + chat-tuned rewriter base + OSS eval framework. No model escalation. Foundation for v1.3 self-evolve.
Requirements: VOICE-01, VOICE-02, VOICE-03, VOICE-04, VOICE-05, VOICE-06, VOICE-07, VOICE-08
**Status:** Plan
**Hard dependency:** Phase 21 Sendblue cutover (shipped 2026-04-27).
**Success Criteria**:
1. DeepEval `pnpm test:voice` runs locally + CI; PR blocks when ClaireVoice rubric通过率 < 75%.
2. Bible v6 shipped with IDENTITY/STYLE/REACTIONS split + Quick Reactions bank + 30+ web-verified 2025-26 网感 phrases.
3. 12 mes_examples relocated from system_prompt block to messages-array alternating user/assistant turns; persistence layer ignores `fs_*` synthetic ids.
4. Rewriter v2 default = SF free Qwen3.5-4B with diff guard (>1.6× len OR >60% drop → reject), p95 ≤ 1.5s, fail-open.
5. Telemetry-only regex log emitting hits to `pa.voice.coach_token.observed` (no transform); feeds v1.3 self-evolve.
6. Dynamic typing dwell 1-4s scaled by reply length, fires on agent reasoning start, stops on send.
7. 3 anchor regression cases PASS (wekruit投递 + vent + celebrate) on baseline rerun.
8. Cringe-warn (not hard-ban) for soft items; hard-ban only confirmed-dead items via web verify.

**Plans:** 5/7 plans executed

Plans:
- [x] 24-01-eval-foundation-PLAN.md — DeepEval workspace + claude-opus-4-5 judge + rubrics + promptfoo A/B + voice-eval.yml CI gate (Wave 1)
- [ ] 24-02-golden-dataset-PLAN.md — Firestore extract + LLM-gen synthetic/adversarial fixtures + Adam HITL 50-case labeling + 3 anchor regressions (Wave 2)
- [x] 24-03-bible-v6-fewshot-PLAN.md — Bible v6 IDENTITY/STYLE/REACTIONS split + 12 mes_examples relocated to fewShotMessages + orchestrator wiring + persistence fs_* filter (Wave 3, parallel)
- [x] 24-04-rewriter-v2-PLAN.md — Qwen/Qwen3-8B default + positive-replacement v2 prompt + <think> strip + diff guard >1.6×|<0.4× + temp 0.4 (Wave 3, parallel)
- [x] 24-05-coach-token-telemetry-PLAN.md — coach-token-monitor.ts telemetry tap (zh/en coach verbs, bullets, numbered, 4+ subordinate chain), no transform (Wave 3, parallel)
- [x] 24-06-typing-dwell-PLAN.md — computeTypingDwellMs(replyLength) 1-4s bands + outbox.ts step 5 dynamic + env override (Wave 3, parallel)
- [ ] 24-07-verification-PLAN.md — Adam infra prep + full DeepEval suite + 3 anchor regression PASS + Adam smoke + STATE/RETROSPECTIVE updates (Wave 4)

## Phase 24.5: Feature Flag Infrastructure (cross-cutting)

**Goal:** Replace scattered `PA_*` env-var flags with a unified Firestore-backed feature flag system. 30s TTL in-process cache, dashboard CRUD UI, audit log, perUser scope (test number bypass).
Requirements: P10 strategic cut 2026-04-28 (`v1.2-p10-strategic-cut.md`)
**Status:** Planned — ready to execute.
**Success Criteria**:
1. `getFlag(key, ctx)` SDK callable from CF + dashboard-web.
2. `pa_feature_flags/{key}` Firestore collection with schema `{key, value, type, scope, allowlist[], blocklist[], updatedAt, updatedBy, reason, version}`.
3. Dashboard `/admin/flags` page: list / edit / revert / audit history (uses existing dashboard-web shell).
4. 30s TTL in-memory cache with ≥95% hit rate (unit tested).
5. Migrate 4 env-vars (`PA_CHANNEL_LEGACY` / `PA_PROACTIVE_DISABLED` / `PA_VOICE_MIRROR_DISABLED` / `paRateLimitPerUserEnabled`) to flags. Env retained as emergency override.
6. Per-user bypass tested with Adam's test number.
7. CRUD writes audit row to `pa_audit_events`.

**Plans:** TBD by gsd-planner (single phase, ~4-6 plans expected).

## Phase 25: Voice Review Dashboard

**Goal:** Build the data producer for v1.3 self-evolve loop. Dashboard page lets Adam (and later HITL reviewers) score assistant turns 1-5⭐ with violation tags + comment, persisted to Firestore. Includes one-click eval rerun + diff vs baseline.
Requirements: P10 strategic cut 2026-04-28
**Status:** Planned — ready to execute (parallelable with Phase 26).
**Success Criteria**:
1. New `apps/dashboard-web/src/pages/Voice.tsx` page lists `pa_messages` assistant turns, paginated, newest first.
2. Each turn UI: 1-5⭐ rating, multi-select violation tags (`probe`/`diagnose`/`too_long`/`tone`/`ai_speak`/`ok`), comment field, save button.
3. `pa_voice_reviews/{messageId}` Firestore collection with schema `{messageId, rating, tags[], comment, reviewerId, agentSnapshot: {bibleVersion, modelId}, createdAt}`.
4. Keyboard-driven UX: 1-5 number keys for rating, Tab to comment, Enter to save (R1 mitigation — Adam alone could review 50 turns in <30 min).
5. One-click "Run eval against golden-50" button → triggers `PA_RUN_EVAL=1 deepeval test run` via CF or local script → writes `eval-results/{timestamp}.json` → renders score + diff vs latest baseline in page.
6. High-rated turn (≥4⭐) flagged as fewShot candidate (highlight in UI; export tool later).
7. Low-rated turn (≤2⭐) tagged for Phase 27 self-evolve cron consumption (read-only contract).

**Plans:** TBD by gsd-planner (~3-5 plans).

## Phase 26: Productionize P0 (公测 hard gate)

**Goal:** Close 4 P0 ops debts that block public closed-beta launch.
Requirements: P10 strategic cut 2026-04-28
**Status:** Planned — ready to execute (parallelable with Phase 25).
**Hard dependency:** Phase 24.5 Feature Flag Infra ships first (rate-limit gate uses `getFlag()`).
**Success Criteria**:
1. Per-user rate limit (≤ N msg/min, default N=20) enforced at `paSendblueWebhook` entry. Gated by `paRateLimitPerUserEnabled` flag (Adam test number → `false` via perUser blocklist; prod users → `true`).
2. Sendblue Free tier daily quota monitor: CF reads daily outbound count from `pa_outbound`, soft alert at 80% of quota, hard block at 100% with audit event.
3. Cloud Logging dashboard exposing: per-CF latency p50/p95, error rate, gpt-5.4-nano spend (tokens × price). Cost alert email when spend > $10/day.
4. agent-registry version pinning: env override `PA_AGENT_REGISTRY_VERSION` reads desired Bible version from seed.json's versioned entries (or pin to a Firestore `agents/{slug}/versions/{v}` doc); 一键 rollback by changing flag.

**Plans:** TBD by gsd-planner (~4 plans).

## Phase 27: Productionize P1+P2 + Self-Evolve Cron

**Goal:** Close P1+P2 ops debts and ship the self-evolve loop closure (gated). Absorbs old Phase 25 Voice Self-Evolve frozen spec.
Requirements: P10 strategic cut 2026-04-28; old `phases/25-voice-self-evolve/25-CONTEXT.md` frozen spec.
**Status:** Planned — gated.
**Hard gate (all required):**
- Phase 26 P0 ships and runs stable for 2 calendar weeks (cost alerts and rate-limit don't fire spuriously).
- ≥200 voice reviews collected via Phase 25 dashboard.
- `selfEvolveEnabled` flag explicitly set to `true` by Adam.

**Success Criteria**:
1. Qwen rewriter circuit breaker: 5 consecutive 404/timeout → flip flag `paVoiceRewriterEnabled` to false, alert Adam, fall back to nano-only output.
2. Qdrant ↔ Firestore memory drift cron (daily): emit drift count metric, alert if drift > 1% of total memories.
3. CF /health endpoint × 5 (paSendblueWebhook / paSendblueOutbox / onPaInbound / paProactiveSweep / memoryAdmin), each returns `{ok, version, deps: {...}}`.
4. SLO definitions + error budget tracking (latency, availability, voice quality).
5. Self-evolve cron (daily): read `pa_voice_reviews` low-rated turns from past 24h, cluster by violation tag, generate Bible patch suggestion, open PR (never push), block merge unless eval gate ≥ baseline. HITL review required.
6. Hermes-style prompt-injection scanner runs on user inputs before agent turn, low-confidence prompt-injection events written to `pa_abuse_events`.

**Plans:** TBD by gsd-planner (~6-8 plans).

## Phase 28: Multi-Turn LLM-vs-LLM Dialog Sim Eval

**Goal:** Add orthogonal regression coverage on top of Phase 24's single-turn golden-50 baseline. Simulate 5 user personas chatting with Claire for K=8 rounds; ConversationalGEval judges full transcripts on voice consistency / mode-switch fluidity / no-probe-regression / 油腻-absence / first-person opener density / memory scaffolding.
Requirements: P10 strategic addition 2026-04-28
**Status:** Planned — no hard gate (independent of Phase 27 self-evolve).
**Hard dependency:** Phase 24 judges + thresholds (already shipped — `apps/eval/voice/judges/claude_judge.py`).

**Success Criteria**:
1. 5 personas (`anxious_grad` / `formal_em` / `chatty_curious` / `vent_seeker` / `hype_announcer`) defined under `packages/pa-orchestrator/src/eval/sim-personas/` with system prompt + opening message + behavior rules.
2. Simulation runner orchestrates persona-LLM × Claire alternately for K=8 turns; captures full transcript with timing + token counts.
3. DeepEval `ConversationalGEval` extended with 6 multi-turn metrics judged on the full transcript.
4. Per-(persona × metric) cell scored; aggregate ≥3.5/5 (0.7 normalized) target.
5. Results persisted to `pa_voice_sim_runs/{runId}` Firestore collection.
6. Dashboard `/voice` page gets new "N-round Sim Eval" tab with run list + transcript drill-in + per-turn judge scores.
7. CI workflow `.github/workflows/voice-sim.yml` runs sim-eval on PRs labeled `run-voice-sim` (label-gated, not always-on — cost control).

**Plans:** 5 sub-tasks (T1-T5 detailed in `phases/28-multi-turn-sim-eval/PLAN.md`). Single P8 sequential, ~3.5 dev-day total.

**Why land before Phase 27 self-evolve unlocks:** Useful as pre-launch voice baseline coverage. Useful as a pre-merge gate for any future Bible patch (manual or self-evolve cron). Catches mode-switch / probe-regression failures that single-turn golden-50 cannot detect.

---

## v1.1 Launch Gate

Closed-beta GO when:
- [x] Phase 16 + 17 baseline (cursor + allowlist) — landed 2026-04-27
- [ ] Phase 18 Voice v1 — eval ≥2.4/3, pairwise win ≥70%
- [ ] Phase 20 Normalizer — 0 markdown leakage, 0 UTM leakage in 50-turn audit
- [ ] Phase 21 Sendblue migration — round-trip smoke pass (OR explicit Adam decision to defer to public launch and stay on macOS for beta)
- [ ] Phase 23 Onboarding — 20-user runbook + abuse panel live
- [ ] Character Bible v1 — Adam owner, written

Phase 19 (Adaptive Mirror) and Phase 22 (Proactive Check-in) are **post-beta P1** unless Adam pulls them forward; they make the product feel alive but aren't strict launch gates.

## v1.1 Public Launch Gate (post closed-beta, separate cycle)

- B4 Secrets to GCP Secret Manager
- B1 Apple ID risk fully resolved (Sendblue or Business Chat)
- GDPR/CCPA delete API + abuse events full producers
- Phase 19 + Phase 22 completed

---

## Milestone v1.4 — Humanize-Runtime v2 (Bilingual, Eval-First)

**Goal:** Push Claire's bilingual (zh+en) conversational humanness to ~70-80% Pi-level on 5 quantified metrics by attacking 4 production failure modes (verb-mirror / length escalation / code-switch drift / self-repeat advice) via deterministic detectors + ImperfectionInjector + ESConv-FSM + memory policy. **Eval-first** ordering — no module work until baseline locked. **0 net new LLM calls** in production path.

**Spawned:** 2026-04-29 after two independent Deep Research reports (Compass + DR-2) cross-validated original v1.4 architecture. Both verdicts: PROCEED-WITH-MODIFICATIONS. v2 incorporates all critical recommendations (drop critic loop, demote Plutchik, position-constrain ImperfectionInjector, add crisis routing, run external benchmarks).

**Estimate:** ~7.5 dev-days.

**Canonical doc:** [`MILESTONE-v1.4-humanize-runtime-v2.md`](./MILESTONE-v1.4-humanize-runtime-v2.md). Full Decision Log (D1-D16) + reuse manifest + research repos there.

| # | Phase | Goal | Requirements | Quantitative Gate (no merge unless met) | Status |
|---|-------|------|--------------|-----------------------------------------|--------|
| 33 | Eval Harness Extension | Extend `tests/scenarios/lib/voice-axes.mjs` with 4 new axes (drift_resistance / length_compliance / advice_novelty / strategy_fit). Add bilingual sentence splitter, BGE-M3 embed-sim wrapper, drift-score harness. 5+ new scenario YAMLs. | HARNESS-01..05 | All 4 axes return numeric scores on existing 20 scenarios; bilingual sentence splitter passes 30+ unit tests | Not started |
| 34 | Baseline Measurement | Run pairwise-runner on all `eval-voice-*.yaml` + sim-audit-rev56.mjs. Lock 5-metric report in `.planning/baseline-rev00056.md`. Define quantitative gates per Phase 35-40. | BASELINE-01..04 | `.planning/baseline-rev00056.md` committed with 5 metric numbers + per-phase gates | Not started |
| 35 | 4 Deterministic Detectors (F1-F4 bilingual) | F1 verb-mirror (zh char 3-gram + en bigram). F2 length cap (3 sentences). F3 lang-lock reinforcement. F4 advice-repeat (BGE-M3 cos-sim vs last 3 turns). Wired into voice rewriter Phase 4; failures → strip / regenerate / reject-resample. | DETECT-01..07 | Detector recall ≥ 80% on rev-00056 known fails; false positive rate ≤ 10% | Not started |
| 36 | ImperfectionInjector + 3-arm A/B | 3-arm A/B router (0/15/30%), turn-onset position-constrained, bilingual policies (zh + en fillers + self-correct), type priority self-correct > hesitate > clarify > uncertainty. A/B harness via existing pairwise-runner. | IMPERFECT-01..07 | A/B winner determined via pre-registered statistical significance; chosen arm beats 0% control on humanness axes ≥ 10pp | Not started |
| 37 | FSM (5 UX × ESConv 8 strategies) | 5 UX state enum + ESConv 8 strategy enum (bilingual labels). State × strategy allowed-set table per ESConv 3 stages. Rule-based state classifier (no LLM). TransESC-style transition table. Phase 3 prompt directive. | FSM-01..07 | ux_state classifier accuracy ≥ 70%; strategy_fit ∈ allowed-set 100% | Not started |
| 38 | Memory Policy (advice-tracker + contradiction) | advice-tracker.ts with BGE-M3 embedding + Firestore persistence. Mem0 fact diff for contradiction. Phase 3 prompt extended with "已经给过的建议" / "Already-given advice" injection. Pin Mem0 extractor to Qwen-7B+. Bilingual retrieval test. | MEMORY-01..06 | 50-turn synthetic advice repeat rate < 5%; contradiction detector ≥ 90% on seeded fixtures | Not started |
| 39 | External Auto Benchmarks (5 benchmarks) | BotChat (open-compass, bilingual auto Turing-style). CharacterEval (morecry, ZH 77 char × 12 metrics). EmpatheticDialogues (facebookresearch, EN 25k). ESConv (thu-coai, EN 8 strategies). RoleLLM (InteractiveNLP-Team, EN 100 char). Compare Qwen-7B raw vs Claire stack to public leaderboards. | BENCH-01..07 | Total spend ≤ $25; Claire stack ≥ Qwen-72B raw on ≥ 1 of 5 benchmarks | Not started |
| 40 | Bible v7.5 + Crisis Red-team + Ship | Bible v7.5 with bilingual NEVER + zh+en slang bank + crisis safety prompt section (zh+en triggers + safe response template + 心理援助热线 400-161-9995 + Crisis Text Line 741741) + 3-sentence cap directive. Feature flag `PA_HUMANIZE_RUNTIME_ENABLED`. 20 crisis red-team prompts auto-tested. SiliconFlow prefix cache POC. | BIBLE-01..03, SHIP-01..05 | 20 crisis red-team prompts route to safety branch 100%; final audit — all 5 metrics meet target vs Phase 34 baseline; benchmark report meets ≥1 of 5 criterion | Not started |

### v1.4 Decision Log Summary (D1-D16)

D1: Drop Reflexion-lite critic loop default | D2: Plutchik demoted to internal scaffold (use 大连理工 7-class for ZH, GoEmotions for EN) | D3: ImperfectionInjector 3-arm A/B + turn-onset only | D4: Crisis routing via Bible prompt (no separate classifier) | D5: Mem0 keep, pin extractor to Qwen-7B+ | D6: FiSMiness baseline arm in eval | D7: Add SiliconFlow prefix cache | D8: No new monorepo package; extend pa-orchestrator/voice/ | D9: Bilingual focus zh + en + mixed | D10: Borrow ESConv 8 + TransESC + genagents reflection | D11: Chinese affect = 大连理工 7-class | D12: Length cap = prompt + post-gen detector strip | D13: Reuse existing tests/scenarios/ harness | D14: Embedding stack = BAAI/bge-m3 via SiliconFlow | D15: Run all 5 external benchmarks | D16: Eval-first phase ordering

### v1.4 Launch Gate (closed-beta humanize-runtime rollout)

- [ ] Phase 34 baseline locked
- [ ] Phase 35 detectors recall ≥ 80%
- [ ] Phase 36 A/B winner picked (or 0% control wins → ImperfectionInjector disabled in production)
- [ ] Phase 37 FSM strategy_fit 100%
- [ ] Phase 38 advice repeat < 5%
- [ ] Phase 39 ≥ 1 of 5 benchmarks beats Qwen-72B raw
- [ ] Phase 40 crisis red-team 100% + 5-metric audit pass
- [ ] Feature flag rollout: 1% → 10% → 50% → 100% (gated by 5-metric monitoring)

### v1.4 Backlog (defer to v1.5)

- Jones & Bergen 5-min Turing test human raters (~$300 + 7d)
- TexturePool recruitment (10-user × 2h interview, 250-fact pool)
- Big5-Chat trait scoring engineering
- Reflexion-lite critic resurrection (would need new evidence)
- LoCoMo memory benchmark (repo offline)

---

## Phase Details (29-40)

> Detail sections so `gsd-tools roadmap analyze` can discover phases 29-40. Summary rows live in their respective milestone tables above.

### Phase 29: Agent Handbook

**Goal:** Bible-as-data. Convert inline `systemPrompt` to versioned, dashboard-editable Firestore `pa-handbooks/{slug}` collection with audit + rollback. Replaces single-source systemPrompt field on agent docs.

**Requirements:** v1.3 P10 expansion 2026-04-28
**Status:** Planned — CONTEXT.md + PLAN.md exist at `.planning/phases/29-agent-handbook/`
**Workstream:** Stream A (v1.3 infra)

### Phase 30: Downstream Eval Connector

**Goal:** Post-turn eval pipeline with regex/nl_judge condition + HMAC-signed POST dispatcher to partner endpoints. Fire-and-forget, never blocks chat path. Per-(user × trigger) cooldown via Firestore composite key.

**Requirements:** v1.3 P10 expansion 2026-04-28
**Status:** Planned — CONTEXT.md + PLAN.md exist at `.planning/phases/30-downstream-eval-connector/`
**Workstream:** Stream A (v1.3 infra)

### Phase 31: Upstream Event Connector

**Goal:** Inbound webhook `paInboundEvent` HTTPS CF with HMAC verify + template lookup + Mustache-lite renderer + rate-limit + enqueue to existing `pa-outbound`. External partners push events → proactive Claire message.

**Requirements:** v1.3 P10 expansion 2026-04-28
**Status:** Planned — CONTEXT.md + PLAN.md exist at `.planning/phases/31-upstream-event-connector/`
**Workstream:** Stream A (v1.3 infra)

### Phase 32: Dashboard IA Reorg + Stress Harness + Playbooks/Personas CRUD

**Goal:** Convert dashboard from engineering console → operator console. 5-category sidebar reorg, delete Playground/Platform, demote Operations. Rebuild Conversations/UserDetail/Voice/Flags-history rows. Add `apps/stress/` Artillery package for concurrent burst testing. Firestore-backed Playbooks + Personas CRUD (soul.md three-file pattern). Investigate + repair `paSendblueOutbox` last-deploy fail.

**Requirements:** v1.3 P10 spawn 2026-04-28
**Status:** Planned — CONTEXT.md exists at `.planning/phases/32-dashboard-ia-reorg/`. 4 parallel waves designed.
**Workstream:** Stream B (v1.3 dashboard reorg, parallelizable)

### Phase 33: Eval Harness Extension

**Goal:** Extend `tests/scenarios/lib/voice-axes.mjs` with 4 new axes (drift_resistance / length_compliance / advice_novelty / strategy_fit). Add bilingual sentence splitter, BGE-M3 embed-sim wrapper, drift-score harness. 5+ new scenario YAMLs covering 50-turn drift / advice repeat / FSM strategy fit / bilingual code-switch.

**Requirements:** HARNESS-01..05
**Status:** Planned — must finish before Phase 34 baseline measurement (D16 eval-first ordering)
**Workstream:** Stream C (v1.4 humanize-runtime)

### Phase 34: Baseline Measurement

**Goal:** Run pairwise-runner on all `eval-voice-*.yaml` + `sim-audit-rev56.mjs`. Lock 5-metric report in `.planning/baseline-rev00056.md`. Define quantitative gates per Phase 35-40.

**Requirements:** BASELINE-01..04
**Status:** Planned — gates all subsequent v1.4 phases (D16)
**Workstream:** Stream C (v1.4 humanize-runtime)

### Phase 35: 4 Deterministic Detectors (F1-F4 bilingual)

**Goal:** F1 verb-mirror (zh char 3-gram + en bigram). F2 length cap (3 sentences). F3 lang-lock reinforcement. F4 advice-repeat (BGE-M3 cos-sim vs last 3 turns). Wired into voice rewriter; failures → strip / regenerate / reject-resample.

**Requirements:** DETECT-01..07
**Status:** Planned — gated on Phase 34 baseline
**Workstream:** Stream C (v1.4 humanize-runtime)

### Phase 36: ImperfectionInjector + 3-arm A/B

**Goal:** 3-arm A/B router (0/15/30%), turn-onset position-constrained, bilingual policies (zh + en fillers + self-correct). Type priority: self-correct > hesitate > clarify > uncertainty. A/B harness via existing pairwise-runner.

**Requirements:** IMPERFECT-01..07
**Status:** Planned — parallelizable with Phase 37 after Phase 35
**Workstream:** Stream C (v1.4 humanize-runtime)

### Phase 37: FSM (5 UX × ESConv 8 strategies)

**Goal:** 5 UX state enum + ESConv 8 strategy enum (bilingual labels). State × strategy allowed-set table per ESConv 3 stages. Rule-based state classifier (no LLM). TransESC-style transition table. Phase 3 prompt directive.

**Requirements:** FSM-01..07
**Status:** Planned
**Workstream:** Stream C (v1.4 humanize-runtime)

### Phase 38: Memory Policy (advice-tracker + contradiction)

**Goal:** `advice-tracker.ts` with BGE-M3 embedding + Firestore persistence. Mem0 fact diff for contradiction. Phase 3 prompt extended with "已经给过的建议" / "Already-given advice" injection. Pin Mem0 extractor to Qwen-7B+. Bilingual retrieval test.

**Requirements:** MEMORY-01..06
**Status:** Planned
**Workstream:** Stream C (v1.4 humanize-runtime)

### Phase 39: External Auto Benchmarks (5 benchmarks)

**Goal:** BotChat (open-compass, bilingual auto Turing-style) + CharacterEval (morecry, ZH 77 char × 12 metrics) + EmpatheticDialogues (facebookresearch, EN 25k) + ESConv (thu-coai, EN 8 strategies) + RoleLLM (InteractiveNLP-Team, EN 100 char). Compare Qwen-7B raw vs Claire stack.

**Requirements:** BENCH-01..07
**Status:** Planned — parallelizable with Phase 37/38
**Workstream:** Stream C (v1.4 humanize-runtime)

### Phase 40: Bible v7.5 + Crisis Red-team + Ship

**Goal:** Bible v7.5 with bilingual NEVER + zh+en slang bank + crisis safety prompt section (zh+en triggers + safe response template + 心理援助热线 400-161-9995 + Crisis Text Line 741741) + 3-sentence cap directive. Feature flag `PA_HUMANIZE_RUNTIME_ENABLED`. 20 crisis red-team prompts auto-tested. SiliconFlow prefix cache POC.

**Requirements:** BIBLE-01..03, SHIP-01..05
**Status:** Planned — final v1.4 phase. If Phase 29 Handbook ships first, Bible v7.5 loads via handbook collection; else inline in agent seed.
**Workstream:** Stream C (v1.4 humanize-runtime)

---

## Cross-stream Sync Points (P10 strategic decisions)

| Sync | Stream A | Stream C | Action |
|------|----------|----------|--------|
| S1 | Phase 29 ships handbook | Phase 40 Bible v7.5 | If 29 done, Bible v7.5 → `pa-handbooks/claire` v2; else inline seed |
| S2 | Phase 30 downstream eval connector | Phase 33 eval harness | Different "eval" namespaces (runtime nl_judge vs offline pairwise judge); zero file collision verified |
| S3 | Phase 32 dashboard reorg Wave 3 (Personas CRUD) | Phase 38 memory policy | Personas seed contains current Bible voice; Phase 38 must not depend on inline strings |


---

## Milestone v1.5 — Friend-Companion Job-Rec System (production-grade)

**Goal:** Convert Claire from "voice-good but flow-stiff job push bot" → friend-toned recommender that talks like a roommate, knows you from CV alone, never floods, scales without Mac mini. 14 Adam-stated streams unified.

**Spawned:** 2026-05-02 by P10 from Adam directive after H7 daily push received as 人机.

**Estimate:** ~18 dev-days (delivered in single autonomous session via parallel P7 wave).

**Status:** ✅ ALL 14 STREAMS SHIPPED 2026-05-02 (13 commits + Mac mini bootstrap + qa:v1.5 gate PASS). Adam HITL deploy + SMS smoke pending.

| # | Phase | Stream | Status | Commit |
|---|-------|--------|--------|--------|
| 41 | Friend-tone CV-aware opener | H13 | ✅ COMPLETE 2026-05-02 (113/113 + LIVE Adam push handle 140e3177) | `bc8863c` |
| 42 | Async match-explainer (Qwen-7B) | F | ✅ COMPLETE 2026-05-02 (140/140 — 11+3 new, $1/day cap) | `92db7cb` |
| 43 | Hard filters (YoE/visa/research/loc) | C | ✅ COMPLETE 2026-05-02 (161/161 — 21 new, 4-tier fallback) | `a3a03dd` |
| 43.5 | Startup-vs-corp boost | I | ✅ COMPLETE 2026-05-02 (24/24 cross-encoder, 80-entry FAANG allowlist) | `c49884d` |
| 44 | Onboarding probe v2 | B | ✅ COMPLETE 2026-05-02 (255/255 — 12 new, 8-state machine + statedPreferences) | `b1b0468` |
| 45 | Message coalescer | D | ✅ COMPLETE 2026-05-02 (6/6 + 336/336, R1 sweep, Cloud Tasks bootstrap done) | `d8e91b8` |
| 46 | Safety / abuse hardening | E | ✅ COMPLETE 2026-05-02 (14+4 — 3-layer: injection + illegal + rate-abuse) | `a92f5fe` |
| 47 | Matching repo cloud audit | A | ✅ COMPLETE 2026-05-02 (Option D — Mac mini stays + webhook bridge) | `6c6f3b2` |
| 47.1 | Mac mini → paMatchingPipelineComplete webhook | A2 | ✅ COMPLETE 2026-05-02 (345/345 — 9 new, HMAC + dashboard tile + bash patch) | `471e25b` |
| 49 | Reverse-match dashboard | H | ✅ COMPLETE 2026-05-02 (351+161+11 — 6 backend + 4 frontend tests) | `edd9226` |
| 50 | E2E QA team CN+EN | J | ✅ COMPLETE 2026-05-02 (4 agents × 8 personas × bilingual gate PASS in 262ms / $0) | `97b53b6` |
| 51 | Tag-grouped rec (G.1 research) | G | ✅ G.1 SHIPPED 2026-05-02 (premise audit; G.2 build deferred — TS-native ~150 LOC, $0/mo) | `be420b0` |

**Backlog deferred to v1.6:**
- G.2 build (TS-native cluster cache, pending Adam premise approval)
- LIVE mode for qa:v1.5 (ship Firestore + OpenAI creds in CI = security trade-off)
- 30-day staleness check on statedPreferences
- Legacy complete-state users re-probe backfill
- Adam-CV live load in Agent-Resume
- Per-tenant flag bucketing for non-WeKruit recruiter clients
- Notify-history surface (dupe prevention in reverse-match)

**Adam HITL queue:**
1. firebase deploy + fill PA_COALESCE_TARGET_URL + redeploy
2. flag flips for canary (see `.planning/V1.5-ROLLOUT.md`)
3. SMS LIVE smoke (Adam-only, kept by Adam direction)
4. Mac mini patch apply (`apps/functions/src/WEKRUIT-MATCHING-PATCH.md`)
5. G.2 build go/no-go (read RESEARCH.md §0 premise re-frame)

**Cross-stream collisions resolved during this session:**
- daily-batch.ts shared between H13 + Stream-C + Stream-F + Stream-I — final state in HEAD verified internally consistent (140/140 tests)
- Stream-D self-reset accidentally dropped 0e8997a Stream-B commit — recovered via cherry-pick to `b1b0468`
- WHERE-domain discipline enforced: each P7 only commits its own files; P10 reconciles via TodoWrite tracker
