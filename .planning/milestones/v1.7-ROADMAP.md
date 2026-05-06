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

---

## Milestone v1.6 — Unified Canonical Tags & Match Quality v1

**Goal:** Replace fragmented industry/skill/topSkill logic across `cv-ingest` + `parsedCandidateResumes` + `pa-users` + `matching-jobs` with single-source canonical 2-axis vocab in `packages/shared-tags`. Match cascade: hard filter → soft score → LLM rerank async → emb fallback. All vocab spelled out, **no abbreviations**.

**Spawned:** 2026-05-05 after iter34 sprint surfaced fragmented tag system as root cause of bad match quality (SWE candidate Adam recommended BDR / Account Manager / Warehouse Team Lead). Design conversation locked **16 decisions** (D1–D16) before code dispatch — see `PROJECT.md` and `STATE.md`.

**Estimate:** ~10–14 dev-days across **11 phases (52–62)**, each 1–2 dev-days. Eval-first ordering applied via Phase 61 (QA evaluator runs against changed runtime — baseline locked AFTER vocab foundation).

**Phases:**

- [ ] **Phase 52: Canonical Tag Vocab Foundation** — `packages/shared-tags` extends 10 axes, all spelled-out, zod write-time validation. Foundation for all downstream phases.
- [ ] **Phase 53: pa-resume-parser v2 wire + relevantTags extract** — cv-ingest wires v2 `parseResumeText`, schema gains `relevantIndustry` / `relevantSpecialization` / `proposedTags`, idempotency + Sonnet-4-6 fallback in chain.
- [ ] **Phase 54: Unified pa-users.tags writer** — single source-of-truth user tag store, `mergeUserTags()` only writer, migration script for 100+ existing users.
- [ ] **Phase 55: matching-jobs schema migration + roleFunction backfill** — Firestore schema gains `roleFunction[]`, deterministic 116K-job migration from `industry` → 17 jobright role functions.
- [ ] **Phase 56: queryMatchingJobs read pa-users.tags + filter + score** — generateJobRecs reads exclusively from pa-users.tags, hard-filter chain + soft score weights + per-job reasoning with top-2 weighted skills.
- [ ] **Phase 57: Liveness/404 sweep + atsApplyUrl backfill** — daily 404 sweep CF + 30K active in <60min, dead>30d hard-delete, paBackfillMatchingJobsAtsUrl wired into daily.
- [ ] **Phase 58: Nightly LLM rerank batch + per-skill JD-rel weight** — Cloud Scheduler 03:00 UTC Qwen-7B JSON-mode batch, `pa-user-rerank-cache` + `pa-user-skill-jdrel-cache`, fire-and-forget reuse.
- [ ] **Phase 59: Dashboards (canonical-tags + qa-evaluator + onboarding-questions extension)** — `/admin/canonical-tags` with sandbox-promotion + counts; `/admin/qa-evaluator` weekly results; `/admin/onboarding-questions` per-user pa-users.tags view.
- [ ] **Phase 60: Dev triggers + scenarios + fixtures** — `__PA_FIND_MATCH__` mirrors `__PA_RESET__`, scenario runner `--user-id` flag, dump tail rerank-cache flag, 5-persona fixture set.
- [ ] **Phase 61: QA evaluator thread weekly run** — Cloud Scheduler `paQaEvaluatorWeekly` Mon 09:00 UTC, 100 user×match pair sample, hard-filter pass + top-3 acceptable, failure-loop until ≥90%/70% pass.
- [ ] **Phase 62: Documentation (CLAUDE.md / MILESTONE-v1.6.md / cross-repo handoff)** — milestone doc, CLAUDE.md design lock, packages/shared-tags README, wekruit-scraping `WEKRUIT_PA_TAG_HANDOFF.md`.

**Phase summary table:**

| # | Phase | Goal | Requirements | Quantitative Gate | Status |
|---|-------|------|--------------|-------------------|--------|
| 52 | Canonical Tag Vocab Foundation | Extend `packages/shared-tags` with 10 axes (roleFunction 17 / industrySector 42 / major 45 / visa 4 / jobType 10 / careerStage 13 / location 130+ / relevantTags / skills / sandbox-promote), all spelled-out, zod write-time validation, Firestore overlay readable. | TAG-01..12 | Zod write-time rejects abbreviations + non-canonical tokens; all 10 axes exported with type tests | Not started |
| 53 | pa-resume-parser v2 wire + relevantTags extract | cv-ingest uses `pa-resume-parser` v2 `parseResumeText`; schema extended with `relevantIndustry`, `relevantSpecialization`, `proposedTags` (max 12); LLM chain gpt-5.4-nano → claude-sonnet-4-6 → gpt-4.1-mini; post-parse Claire dialogue confirm; idempotent on sha256. | PARSE-01..09 | Adam re-parse round-trip yields `industryTags = ["artificial_intelligence_and_machine_learning", "technology_general"]` (not `["other"]`); idempotent on sha256 | Not started |
| 54 | Unified pa-users.tags writer | Single source-of-truth `pa-users/{userId}.tags`. cv-ingest + chat-answer hooks both go through `mergeUserTags()` (iter34 H.1). Migration script for 100+ users. Inconsistency surfaced to admin. | USER-TAG-01..05 | All 100+ existing users have populated `pa-users.tags`; only `mergeUserTags()` is the writer (grep shows zero direct writes) | Not started |
| 55 | matching-jobs schema migration + roleFunction backfill | Add `roleFunction: string[]` to `matching-jobs`, retain `industrySector`. Deterministic mapper backfills 116K+ jobs from current `industry` → 17 jobright role functions. | MATCH-02 | 116K+ `matching-jobs` rows have `roleFunction[]`; migration is idempotent + dry-run audit shows ≤1% unmapped | Not started |
| 56 | queryMatchingJobs read pa-users.tags + filter + score | generateJobRecs reads exclusively from `pa-users.tags` (no legacy fallback). Firestore `array-contains-any roleFunction`, limit 500. Hard post-filter chain (visa/loc/stage/jobType/firstSeenAt<20d/atsApplyUrl/dead). Soft score weights (llm 0.40 / skill 0.20 / relevant 0.15 / industry 0.10 / emb 0.10 / salary 0.05). Per-skill base × JD-relative weight. Per-job reasoning shows top-2 weighted skills. | MATCH-01, MATCH-03..08 | SWE Adam scenario yields 0 BDR/sales/cashier recs; per-job reason surfaces top-2 weighted JD-aligned skills; `lastSeenAt` not read (replaced by 20d firstSeenAt window) | Not started |
| 57 | Liveness/404 sweep + atsApplyUrl backfill | Daily Cloud Scheduler HEAD-checks `matching-jobs.atsApplyUrl`, marks dead, hard-deletes >30d. Reuses `paBackfillMatchingJobsAtsUrl` (iter34 G.3). | LIVE-01..04 | jobright.ai-leaked recommendation rate: 50%+ → 0%; sweep clears 30K active in <60min | Not started |
| 58 | Nightly LLM rerank batch + per-skill JD-rel weight | Cloud Scheduler 03:00 UTC Qwen-7B JSON-mode batch. `pa-user-rerank-cache/{userId}` (top-50/active user). Per-skill JD-rel cache `pa-user-skill-jdrel-cache/{userId}/{jobId}`. Reuses fire-and-forget llmRerank (iter34 H.2). | RERANK-01..04 | Nightly batch completes in <24h for all active users; cache stale-by >36h triggers fallback | Not started |
| 59 | Dashboards (canonical-tags + qa-evaluator + onboarding-questions extension) | `/admin/canonical-tags` reads vocab + Firestore overlay + sandbox→canonical promotion + counts. `/admin/qa-evaluator` weekly run results. `/admin/onboarding-questions` per-user `pa-users.tags` view. | DASH-01..04 | Admin can promote a sandbox `proposedTag` to canonical industrySector via UI without code change; counts visible per axis | Not started |
| 60 | Dev triggers + scenarios + fixtures | `__PA_FIND_MATCH__` iMessage trigger. Scenario runner `--user-id <uid>` flag. `dump-outbound-tail.mjs --include-rerank-cache`. 5-persona fixtures (SWE / PM / Designer / ML / Data Analyst). | DEV-01..04 | `__PA_FIND_MATCH__` triggers `generateJobRecs` against any user; 5-persona fixture suite checks in CI | Not started |
| 61 | QA evaluator thread weekly run | `paQaEvaluatorWeekly` (Mon 09:00 UTC), 100 user×match pair sample, Qwen-7B judge, `pa-qa-evaluator-runs/{runId}` writes. Slack/email alert <90%/70%. Failure-loop priority queue until pass. **Eval-first contract:** runs AFTER vocab foundation (Phase 52) so baseline reflects new pipeline. | QA-01..05 | Hard-filter pass ≥90% + top-3 acceptable ≥70% on weekly auto-sample; failure-loop closes within 1 week | Not started |
| 62 | Documentation (CLAUDE.md / MILESTONE-v1.6.md / cross-repo handoff) | `CLAUDE.md` v1.6 design lock. `.planning/MILESTONE-v1.6-unified-tags.md` (architecture + vocab + flow + measurement). `packages/shared-tags/README.md` v1.6 additions. `wekruit-scraping/WEKRUIT_PA_TAG_HANDOFF.md` cross-repo coordination doc. | DOC-01..04 | All 4 docs land before milestone-complete; cross-repo handoff doc reviewed by scraping repo owner | Not started |

### v1.6 Eval-First Ordering Note

P0 = Phase 61 QA evaluator extends BEFORE any runtime change to lock baseline. **However**, Phase 52 (canonical tag vocab) is the foundation everything depends on; without it, every downstream phase has no schema to read. **Resolved order:**

```
Phase 52 (vocab foundation, hard prerequisite)
   ↓
Phase 53–58 (runtime rewire on top of vocab)
   ↓
Phase 61 (QA evaluator runs against new runtime — locks v1.6 baseline)
   ↓
Phase 62 (docs)
   ↓
Milestone close (Phase 61 must pass ≥90%/70% to ship v1.6)
```

Phase 59 (dashboards), Phase 60 (dev triggers) are parallelizable side-tracks. Phase 61 is the final ship gate.

### v1.6 Decision Log Summary (D1–D16)

D1: roleFunction = jobright 17 verbatim (closed enum). | D2: industrySector = 42 add-able via dashboard (sandbox→promote). | D3: major = soft score (not hard filter). | D4: visa = 4 enum (`citizen` / `permanent_resident` / `sponsor_needed` / `other`). | D5: NO abbreviations anywhere (LLM confusion). | D6: relevantTags / proposedTags parse-time extract. | D7: per-skill base + JD-relative weight (Qwen-7B nightly). | D8: unified `pa-users.tags` single source. | D9: hard filter → skill+relevant+industry score → LLM async → emb fallback. | D10: 20d `firstSeenAt` window + 404 daily, abandon `lastSeenAt`. | D11: cv-ingest wires `pa-resume-parser` v2 (not single-shot nano). | D12: post-parse Claire dialogue confirm. | D13: QA evaluator thread weekly. | D14: `__PA_FIND_MATCH__` dev trigger. | D15: reduce regex, prefer LLM. | D16: industry add-able via dashboard.

### v1.6 Goal Metrics (5)

1. SWE candidate Adam (`e5d97cd8-1e1d-439d-8672-3008f8aeef2e`) → BDR/sales/cashier/warehouse leak rate: **100% → <5%**.
2. jobright.ai-leaked match URL rate: **50%+ → 0%**.
3. Adam industryTags: `["other"] → ["artificial_intelligence_and_machine_learning", "technology_general"]`.
4. Per-job reasoning surfaces top-2 JD-aligned weighted skill matches.
5. QA evaluator pass rate: hard filter 100% (no leak), soft score top-3 acceptable **≥70%** weekly auto-sample.

### v1.6 Launch Gate

- [ ] Phase 52 vocab foundation locked + zod schema rejects abbreviations
- [ ] Phase 53 pa-resume-parser v2 wired + Adam re-parse yields correct industry tags
- [ ] Phase 54 unified `pa-users.tags` migration complete (100+ users, 0 direct-writers)
- [ ] Phase 55 `matching-jobs` schema migration complete (116K+ rows backfilled)
- [ ] Phase 56 generateJobRecs read-side cutover; SWE Adam scenario yields 0 BDR/sales recs
- [ ] Phase 57 daily 404 sweep stable; jobright.ai leak rate 0%
- [ ] Phase 58 nightly Qwen-7B rerank batch operational <24h
- [ ] Phase 59 admin dashboards live; sandbox→canonical promotion verified
- [ ] Phase 60 `__PA_FIND_MATCH__` + 5-persona fixtures committed
- [ ] Phase 61 weekly QA evaluator: hard filter ≥90% + top-3 ≥70%
- [ ] Phase 62 docs landed (CLAUDE.md / MILESTONE-v1.6.md / shared-tags README / cross-repo handoff)

### v1.6 Backlog (defer to v2.0)

- CROSS-REPO-PYTHON-PORT — port `packages/shared-tags` to `wekruit-scraping/researcher/pipeline/canonical_tags.py`.
- SCRAPING-EMIT-TAG-EVENTS — `wekruit-scraping/scripts/emit_tag_events.py` writer.
- RECRUITER-AGENT-TAGS — extend tag system to candidate-sourcing flows.
- MULTI-LOCATION-WEIGHTING — distance similarity (NYC ≈ Boston East-coast clustering).
- SKILL-SIMILARITY-EMBEDDING — pre-computed skill embedding dict (python ≈ pyspark).
- RESUME-VARIANT-PER-JOB — VALET-style per-job CV rewriting.

### v1.6 Out of Scope

- Cross-repo Python tag emit (defer v2.0).
- UK/EU/non-NA visa types (NA-only focus).
- Recruiter agent overhaul (already shipped v1.5).
- Multi-language CV parse (English-only).
- Job application auto-fill (qaBank-to-mem0 already covers).
- Real-time match notifications (async daily batch only).

---

## Phase Details (52–62)

> Detail sections so `gsd-tools roadmap analyze` can discover phases 52–62. Summary rows live in the v1.6 milestone table above.

### Phase 52: Canonical Tag Vocab Foundation

**Goal:** Extend `packages/shared-tags` with all 10 canonical axes — `roleFunction` 17 / `industrySector` 42 / `major` 45 / `visa` 4 / `jobType` 10 / `careerStage` 13 / `location` 130+ / `relevantTags` open-vocab / `skills` bucketed open-vocab + per-skill weight / sandbox-promote pattern. **All values spelled out, zero abbreviations** (D5). Zod write-time validation. Firestore overlay (sandbox + promote-to-canonical) for industrySector.
**Requirements:** TAG-01, TAG-02, TAG-03, TAG-04, TAG-05, TAG-06, TAG-07, TAG-08, TAG-09, TAG-10, TAG-11, TAG-12
**Hard prerequisite:** none — foundation phase, blocks all v1.6 downstream phases.
**Reuse:** `packages/shared-tags` already has 10-type + mutexGroup + sha256 + decay (iter30 WS2); extend, don't rewrite.
**Status:** Not started.
**Success Criteria**:
1. All 10 canonical vocabs exported from `packages/shared-tags`, each with zod schema + TS type + tests confirming closed enum size (17 / 42 / 45 / 4 / 10 / 13 / 130+).
2. Zod schema rejects abbreviations (`"swe"`, `"pm"`, `"ml"`, `"ai"`) and any non-`[a-z][a-z0-9_]*` token at write-time, with explanatory error.
3. `industrySector` Firestore overlay (`pa-canonical-vocab/industrySector`) readable from dashboard with per-tag count.
4. Sandbox-promotion API: `proposedTags[]` (max 12, lowercase, sandbox) → admin promote-to-canonical button → write to overlay.
5. `packages/shared-tags` consumers (cv-ingest, generateJobRecs, dashboards) compile against new exports without runtime errors.

### Phase 53: pa-resume-parser v2 wire + relevantTags extract

**Goal:** `cv-ingest` Cloud Function uses `packages/pa-resume-parser` v2 `parseResumeText` — removes inline single-shot nano call. LLM chain `gpt-5.4-nano (primary) → claude-sonnet-4-6 (fallback) → gpt-4.1-mini (final)` with Sonnet-4-6 reintroduced. Schema extended with `relevantIndustry: string[]` / `relevantSpecialization: string[]` / `proposedTags: string[]` (max 12, sandbox) parse-time. Post-parse Claire dialogue confirms understanding ("我看到你: <skills+companies+roles+relevantTags>; 对吗?"). Industry classification reduces regex (D15) — when LLM emits `["other"]`, Sonnet-4-6 second-pass with explicit reasoning prompt. cv-ingest idempotent on sha256.
**Requirements:** PARSE-01, PARSE-02, PARSE-03, PARSE-04, PARSE-05, PARSE-06, PARSE-07, PARSE-08, PARSE-09
**Hard prerequisite:** Phase 52 (vocab schema).
**Reuse:** `packages/pa-resume-parser` already has 3-tier router + valet-port done (iter30 WS1); `apps/functions/src/cv-ingest/cv-ingest.ts` already imports the package (partial wire).
**Status:** Not started.
**Success Criteria**:
1. `cv-ingest` parses Adam's CV (`rQIqQEghvZLwVkMad2lJ`) and yields `industryTags = ["artificial_intelligence_and_machine_learning", "technology_general"]` (D15 second-pass triggered).
2. Schema includes `relevantIndustry`, `relevantSpecialization`, `proposedTags` (max 12), each populated from work history.
3. LLM chain uses Sonnet-4-6 fallback on 5xx/timeout/rate (visible in `pa_tool_calls`).
4. Re-parsing same PDF (same sha256) returns existing `parsedCandidateResumes` record without duplicate side-effects.
5. Post-parse Claire dialogue ("我看到你: ...") fires within 1 turn of cv-ingest completion; user correction writes back through `mergeUserTags()`.

### Phase 54: Unified pa-users.tags writer

**Goal:** Every user has unified `pa-users/{userId}.tags` with full canonical schema. cv-ingest writes `tags.skills` (full list, not truncated) + `tags.industrySector` + `tags.relevantIndustry` + `tags.relevantSpecialization` + `tags.proposedTags` + `tags.embedding` + `tags.lastUpdatedFromCv`. Onboarding chat answer hooks write `tags.targetRole` / `tags.yoeRange` / `tags.visaStatus` / `tags.prefersStartup` / `tags.targetLocations` / `tags.preferredLang` / `tags.lastUpdatedFromChat`. Migration script ports 100+ existing users from fragmented data into `pa-users.tags`. **`mergeUserTags()` is the only writer**.
**Requirements:** USER-TAG-01, USER-TAG-02, USER-TAG-03, USER-TAG-04, USER-TAG-05
**Hard prerequisite:** Phase 52 + Phase 53.
**Reuse:** `packages/pa-orchestrator/src/tags/user-tags-merger.ts` `mergeUserTags()` lib already shipped (iter34 H.1 commit `253ce87`); cv-ingest already calls it (commit `ad099a2`).
**Status:** Not started.
**Success Criteria**:
1. 100% of 100+ existing users have populated `pa-users/{userId}.tags` after migration script (idempotent — re-run is no-op).
2. Missing-tag user surfaced to admin dashboard as "tags-inconsistent" list.
3. `grep -r "pa-users.*\.tags.*set\|pa-users.*\.tags.*update" apps/ packages/` shows zero hits outside `mergeUserTags()` — the only writer.
4. cv-ingest on Adam refresh writes full skill list (not truncated to 12) + relevantIndustry + proposedTags + embedding to `pa-users.tags`.
5. Chat answer hook (onboarding probe v2 from Phase 44) writes targetRole + yoeRange + visaStatus + targetLocations through `mergeUserTags()`.

### Phase 55: matching-jobs schema migration + roleFunction backfill

**Goal:** Firestore `matching-jobs` schema gains `roleFunction: string[]` (closed enum 17 from D1) while retaining `industrySector: string[]`. **Two orthogonal axes.** Deterministic migration backfills 116K+ jobs from current `industry` field via mapper (e.g., `"tech_software"` → `software_engineering`). Migration is idempotent + dry-run audit before write.
**Requirements:** MATCH-02
**Hard prerequisite:** Phase 52 (vocab schema).
**Reuse:** existing iter34 G.3 backfill CF pattern (`paBackfillMatchingJobsAtsUrl`); same job-runner shape.
**Status:** Not started.
**Success Criteria**:
1. 116K+ `matching-jobs` rows have `roleFunction[]` after migration; verified via Firestore aggregate count.
2. Dry-run report shows ≤1% unmapped jobs (logged for manual review, not blocking).
3. Migration is idempotent — second run is no-op (skip rows where `roleFunction` already populated).
4. `industrySector[]` field retained, not destroyed.
5. Sample 100 jobs spot-checked: BDR job → `roleFunction = ["sales"]`, SWE job → `roleFunction = ["software_engineering"]`, no ambiguous mappings.

### Phase 56: queryMatchingJobs read pa-users.tags + filter + score

**Goal:** `generateJobRecs` reads exclusively from `pa-users.tags` (no legacy fragmented reads). Firestore query: `where('roleFunction', 'array-contains-any', user.targetRoleFunction)` + `orderBy firstSeenAt desc` + limit raised 50 → 500. Hard post-filter chain: `visa intersect` → `location intersect (anywhere bypass)` → `careerStage window` → `jobType exact` → `firstSeenAt < 20d` → `atsApplyUrl present + not jobright.ai` → `dead !== true`. Soft score weights: `llm_match 0.40` / `skill_jaccard 0.20` / `relevantTags 0.15` / `industrySector_overlap 0.10` / `cv_emb_cosine 0.10` / `salary_fit 0.05`. Per-skill `skill_jaccard` = base × JD-relative weight (Qwen-7B nightly cache). Per-job reasoning shows top-2 weighted matched skills + reason. **`lastSeenAt` deprecated** — 20d `firstSeenAt` window only.
**Requirements:** MATCH-01, MATCH-03, MATCH-04, MATCH-05, MATCH-06, MATCH-07, MATCH-08
**Hard prerequisite:** Phase 52 + 54 + 55.
**Reuse:** `apps/functions/src/lib/llm-rerank.ts` Qwen-7B JSON-mode (iter34 G.4 / H.2 wire `c187c50`); cvEmbedding already wired (iter34 H.2 `d8e60e3`).
**Status:** Not started.
**Success Criteria**:
1. SWE Adam scenario (`tests/scenarios/eval-adam-real-cv-en.yaml` + new `__PA_FIND_MATCH__` trigger) yields 0 BDR/sales/cashier/warehouse recommendations in top-3 (was 100% leak in iter34 G5 sim).
2. `queryMatchingJobs` reads exclusively from `pa-users.tags` — `grep -r "parsedCandidateResumes" apps/functions/src/job-rec/` shows zero non-test reads on the recommendation hot path.
3. Per-job reasoning message includes top-2 weighted JD-aligned skill matches with reason.
4. `lastSeenAt` field not read anywhere on the recommendation path; only `firstSeenAt < 20d` window enforced.
5. Filter cascade observable in audit log: hard-filter pass count + soft-score breakdown per recommended job.

### Phase 57: Liveness/404 sweep + atsApplyUrl backfill

**Goal:** Daily Cloud Scheduler CF HEAD-checks `matching-jobs.atsApplyUrl` for active jobs, marks `dead=true` on 404/410/500/timeout. Sweep batch 500/min, concurrent 50, 100ms throttle. 30K active in <60min. Re-checks dead jobs after 7d. Dead jobs older than 30d after marking are hard-deleted. `paBackfillMatchingJobsAtsUrl` (iter34 G.3 commit `a56da02`) wired into the daily sweep.
**Requirements:** LIVE-01, LIVE-02, LIVE-03, LIVE-04
**Hard prerequisite:** Phase 55 (schema must include atsApplyUrl).
**Reuse:** `apps/functions/src/backfill-ats-urls.ts` Serper backfill CF.
**Status:** Not started.
**Success Criteria**:
1. Daily Cloud Scheduler runs sweep at fixed UTC time; 30K active jobs HEAD-checked within 60min.
2. jobright.ai-leaked recommendation rate **50%+ → 0%** (combined with Phase 56 hard-filter `not jobright.ai`).
3. Dead-marked jobs age >30d are hard-deleted; verified by Firestore count delta.
4. Re-check after 7d resurrects jobs that come back online (false-positive recovery).
5. Sweep dashboard tile shows daily run health + dead-mark count + delete count.

### Phase 58: Nightly LLM rerank batch + per-skill JD-rel weight

**Goal:** Cloud Scheduler `paLlmRerankNightly` at 03:00 UTC runs LLM JD-CV match scorer using `Qwen/Qwen2.5-7B-Instruct` JSON-mode for top-50/active user. Output stored in `pa-user-rerank-cache/{userId}` with `ranked` + `computedAt`. Read-side falls back if cache stale >36h. Per-skill JD-relative weight stored as `pa-user-skill-jdrel-cache/{userId}/{jobId}`. Async fire-and-forget llmRerank already wired (iter34 H.2 commit `c187c50`); daily batch reuses same function.
**Requirements:** RERANK-01, RERANK-02, RERANK-03, RERANK-04
**Hard prerequisite:** Phase 56 (read path must use cache).
**Reuse:** `apps/functions/src/lib/llm-rerank.ts` Qwen-7B JSON-mode (iter34 G.4); already wired into orchestrator-deps (H.2 `c187c50`).
**Status:** Not started.
**Success Criteria**:
1. Nightly batch runs Mon-Sun 03:00 UTC; completes in <24h for all active users.
2. `pa-user-rerank-cache/{userId}` has `ranked[]` + `computedAt`; stale >36h triggers read-side fallback to embedding cosine.
3. `pa-user-skill-jdrel-cache/{userId}/{jobId}` populated for top-50 user×job pairs; consumed by Phase 56 `skill_jaccard` per-skill weight.
4. Single fire-and-forget llmRerank function reused — no code duplication between sync and nightly paths.
5. Cost ledger logged: tokens × Qwen-7B SiliconFlow price; spend visible in dashboard.

### Phase 59: Dashboards (canonical-tags + qa-evaluator + onboarding-questions extension)

**Goal:** Admin page `/admin/canonical-tags` reads `packages/shared-tags` vocab + Firestore overlay, displays all 10 axes with per-tag counts; supports promoting sandbox `proposedTags` to canonical `industrySector` with one click. Admin page `/admin/qa-evaluator` displays QA evaluator weekly run results (per-pair scores + summary). `/admin/onboarding-questions` extended with link to `pa-users.tags` view per user.
**Requirements:** DASH-01, DASH-02, DASH-03, DASH-04
**Hard prerequisite:** Phase 52 (vocab) + Phase 54 (pa-users.tags).
**Reuse:** existing dashboard-web shell + design system; no new top-level navigation needed.
**Status:** Not started.
**Success Criteria**:
1. `/admin/canonical-tags` lists all 10 axes; counts per tag visible (e.g., `software_engineering: 4310 jobs / 32 users`).
2. Sandbox→canonical promotion button writes to Firestore overlay; promoted tag appears in dropdown next refresh; audit row written.
3. `/admin/qa-evaluator` lists last 8 weekly runs with hard-filter pass + top-3 acceptable + Slack/email alert state.
4. `/admin/onboarding-questions` user row → "View tags" link opens `pa-users/{userId}.tags` Firestore-rendered view.
5. All admin actions audit-logged to `pa_audit_events`.

### Phase 60: Dev triggers + scenarios + fixtures

**Goal:** `__PA_FIND_MATCH__` iMessage trigger forces `generateJobRecs` execution (mirrors `__PA_RESET__` pattern, D14). Scenario runner `tests/scenarios/runner.mjs` gains `--user-id <uid>` flag for real-user scenario runs. `dump-outbound-tail.mjs` extended with `--include-rerank-cache` flag. 5-persona fixture set committed under `tests/fixtures/v1.6-personas/` (SWE / PM / Designer / ML / Data Analyst).
**Requirements:** DEV-01, DEV-02, DEV-03, DEV-04
**Hard prerequisite:** Phase 56 (must have a working generateJobRecs to trigger).
**Reuse:** `__PA_RESET__` trigger pattern in orchestrator dispatch.
**Status:** Not started.
**Success Criteria**:
1. Adam sends `__PA_FIND_MATCH__` via iMessage → `generateJobRecs` fires within 1 turn → match recommendation message returns.
2. `node tests/scenarios/runner.mjs --user-id e5d97cd8-1e1d-439d-8672-3008f8aeef2e` executes scenario against Adam's real CV.
3. `pnpm dump-outbound --include-rerank-cache` shows latest rerank cache state for the dumped user.
4. 5 persona fixtures in `tests/fixtures/v1.6-personas/` (SWE / PM / Designer / ML / Data Analyst) each have `pa-users.tags` JSON + expected top-3 match shape.
5. CI runs all 5 persona fixtures against `generateJobRecs` and verifies no leak (BDR/cashier/warehouse).

### Phase 61: QA evaluator thread weekly run

**Goal:** Cloud Scheduler `paQaEvaluatorWeekly` runs Mon 09:00 UTC, samples 100 user×match pairs, computes hard-filter pass + top-3 acceptable rate via Qwen-7B (D13). Output written to `pa-qa-evaluator-runs/{runId}` with full sample + per-pair score + summary. Surfaced via `/admin/qa-evaluator`. Slack/email alert if pass rate <90% hard filter or <70% top-3 acceptable. Evaluator prompt grounds judgment in candidate's `tags.targetRole` + `tags.relevantIndustry` + `tags.skills` (explicit reasoning per match). Failure-loop: failing pairs go to priority queue, next-week run re-evaluates same users; until pass ≥90%/70%, milestone not-shipped. **This is the v1.6 final ship gate.**
**Requirements:** QA-01, QA-02, QA-03, QA-04, QA-05
**Hard prerequisite:** Phase 56 + 58 (runtime must be in target state); Phase 59 (dashboard surfaces results).
**Reuse:** `apps/functions/src/lib/llm-rerank.ts` Qwen-7B JSON-mode (same model, different prompt); existing Cloud Scheduler infra.
**Status:** Not started.
**Success Criteria**:
1. `paQaEvaluatorWeekly` runs every Mon 09:00 UTC; produces `pa-qa-evaluator-runs/{runId}` doc.
2. 100 user×match pair sample size; each pair has hard-filter-pass bool + top-3-acceptable rating + Qwen-7B reason.
3. Hard-filter pass rate **≥90%** + top-3 acceptable rate **≥70%** on weekly auto-sample → milestone ship gate green.
4. Slack/email alert fires when thresholds breached; alert includes link to `/admin/qa-evaluator` run detail.
5. Failure-loop: priority queue re-evaluates failing pairs in subsequent weekly run; loop closes within ≤2 weeks of breach.

### Phase 62: Documentation (CLAUDE.md / MILESTONE-v1.6.md / cross-repo handoff)

**Goal:** `CLAUDE.md` updated with v1.6 design lock (16 decisions, 5 metrics, vocab references, match flow diagram). `.planning/MILESTONE-v1.6-unified-tags.md` written with full architecture diagram + vocab table + match flow + measurement protocol. `packages/shared-tags/README.md` updated with v1.6 vocab additions + sandbox-promotion pattern + cross-repo notes. `wekruit-scraping/WEKRUIT_PA_TAG_HANDOFF.md` (cross-repo coordination doc, no code change in scraping repo).
**Requirements:** DOC-01, DOC-02, DOC-03, DOC-04
**Hard prerequisite:** Phase 61 (numbers in milestone doc require QA evaluator results).
**Reuse:** existing `MILESTONE-v1.4-humanize-runtime-v2.md` + `MILESTONE-v1.5-friend-companion.md` doc shape.
**Status:** Not started.
**Success Criteria**:
1. `CLAUDE.md` v1.6 section added with 16 decisions + 5 metrics + match flow ASCII diagram.
2. `.planning/MILESTONE-v1.6-unified-tags.md` exists with architecture diagram + 10-axis vocab table + filter→score→rerank flow + measurement protocol.
3. `packages/shared-tags/README.md` documents v1.6 additions + sandbox-promotion pattern + cross-repo handoff note.
4. `wekruit-scraping/WEKRUIT_PA_TAG_HANDOFF.md` ships in scraping repo with v1.6 schema reference + future Python port plan (deferred to v2).
5. Adam reads all 4 docs and confirms v1.6 design lock matches shipped behavior; no doc-vs-code drift.

## Milestone v1.7 — Match Quality Depth + Pipeline Reliability Hardening

**Goal:** Close v1.6 post-ship gaps. Add senior/staff job source. Sponsorship inference. Harden Serper backfill + macmini reliability. Drop legacy. Provision secrets. Ship match-debug admin UI + QA data ramp.

**Spawned:** 2026-05-06 by Adam after v1.6 ship + post-ship matching diagnostics.

**Phase numbering:** continues from v1.6 last phase 62. v1.7 spans phases **63–72** (10 phases).

| # | Phase | Reqs | Status |
|---|-------|------|--------|
| 63 | LinkedIn / Wellfound senior-job scraper | SENIOR-01..05 (5) | Not started |
| 64 | Sponsorship LLM inference + allowlist | SPONSOR-01..05 (5) | Not started |
| 65 | Serper backfill batch parallelism + retry | ATSURL-01..04 (4) | Not started |
| 66 | Macmini Stage 2.5 permanent fix | MACMINI-01..03 (3) | Not started |
| 67 | Launchd reliability + health-check | LAUNCHD-01..03 (3) | Not started |
| 68 | Vocab hygiene closure | HYGIENE-01..04 (4) | Not started |
| 69 | Secrets + Slack alert provisioning | SECRETS-01..03 (3) | Not started |
| 70 | Match-debug admin UI | MATCHDEBUG-01..04 (4) | Not started |
| 71 | QA data ramp (auto-derive tags) | QADATA-01..04 (4) | Not started |
| 72 | Documentation v1.7 | DOC-V17-01..02 (2) | Not started |

**Coverage:** 37/37 REQ-IDs mapped. No orphans.

**Eval-first ordering:**
- Phase 63 (senior source) → Phase 64 (sponsorship inference, depends on richer corpus) → Phase 71 (QA ramp uses both)
- Phase 65 (ATS URL) + 66 (macmini) + 67 (launchd) parallelizable infrastructure track
- Phase 68 (vocab hygiene) + 69 (secrets) + 70 (match-debug UI) parallelizable

### Phase 63: LinkedIn / Wellfound senior-job scraper

**Goal:** Add LinkedIn API + Wellfound + Otta scrapers to `wekruit-scraping/src/wekruit_matching/scraper/` to ingest 100+ senior+staff SWE jobs/day. Per-source feature flags, source attribution, dedup with JobRight corpus.
**Requirements:** SENIOR-01..05
**Hard prerequisite:** macmini SSH access (verified Phase 57). LinkedIn API token (SECRETS-03).
**Status:** Not started.
**Success Criteria:**
1. `wekruit-scraping/src/wekruit_matching/scraper/linkedin.py` + `wellfound.py` + `otta.py` implemented + tested.
2. Daily macmini run ingests ≥100 senior+staff SWE jobs from new sources.
3. Active matching-jobs corpus has ≥5% senior/staff after 7 days of new ingestion.
4. Source attribution `sources: [...]` field present + admin-visible.

### Phase 64: Sponsorship LLM inference + company allowlist

**Goal:** Infer `sponsorship: boolean` from JD text via gpt-5.4-nano/Qwen-7B when scraper raw value is null. Maintain `pa-sponsorship-allowlist` Firestore collection seeded from h1bdata.info + manual curation (200+ companies).
**Requirements:** SPONSOR-01..05
**Status:** Not started.
**Success Criteria:**
1. Backfill script applied to 1944 active jobs; `sponsorship` field populated for ≥80%.
2. V16 hard filter respects null vs false correctly (sponsor_needed × null = keep; × false = drop).
3. Adam scenario top-5 includes ≥1 sponsor=true result.

### Phase 65: Serper backfill batch parallelism + retry

**Goal:** Refactor `paBackfillMatchingJobsAtsUrl` from inline-in-liveness-sweep to dedicated hourly batch CF. 200 jobs/run, 5-concurrent, retry queue for misses.
**Requirements:** ATSURL-01..04
**Status:** Not started.
**Success Criteria:**
1. `paBackfillAtsUrlsBatch` CF deployed, hourly cron.
2. `pa-ats-resolve-priority/{jobId}` retry queue functional.
3. % active jobs missing atsApplyUrl drops from 22% → <5% within 7 days.
4. Cost ledger entries logged + weekly summary email.

### Phase 66: Macmini Stage 2.5 permanent fix

**Goal:** Fix Supabase pooler hang in `wekruit-matching/src/wekruit_matching/pipeline/url_resolver.py` OR migrate URL-resolution to wekruit-pa CF. Remove `SKIP_URL_RESOLUTION=1` hotfix. Fix Stage 2c LLM "connection lost" failures.
**Requirements:** MACMINI-01..03
**Status:** Not started.
**Success Criteria:**
1. macmini daily run completes Stage 2.5 without hang.
2. `SKIP_URL_RESOLUTION=1` removed from `/Users/Shared/wekruit/run-pipeline.sh`.
3. Stage 2c LLM enrichment success rate >80% (currently silent fail).

### Phase 67: Launchd reliability + health-check

**Goal:** Permanently load `com.wekruit.daily-update` + `com.wekruit.health-check` plists. Health-check verifies last successful daily-update <26h ago, alerts via Mailgun. Fix post-pipeline-webhook PermissionError.
**Requirements:** LAUNCHD-01..03
**Status:** Not started.
**Success Criteria:**
1. Both launchd services loaded + persistent across reboots.
2. Health-check fires hourly; alerts on 26h staleness.
3. post-pipeline-webhook completes without error.

### Phase 68: Vocab hygiene closure

**Goal:** Delete legacy `apps/job-rec/src/tools/query-matching-jobs.ts`. Tighten seniorityLevel + jobType regex. Backfill remaining ~38 parsedCandidateResumes canonical fields.
**Requirements:** HYGIENE-01..04
**Status:** Not started.
**Success Criteria:**
1. Legacy file deleted; tests still pass against V16.
2. matching-jobs raw-value seniority pollution = 0 (no `Entry Level` + `New Grad, Entry Level` etc).
3. parsedCandidateResumes canonical `industries` + `relevantIndustry` populated for all 44 docs.

### Phase 69: Secrets + Slack alert provisioning

**Goal:** Provision `ANTHROPIC_API_KEY`, `PA_SLACK_ALERT_WEBHOOK`, `LINKEDIN_ACCESS_TOKEN` Firebase Secrets / macmini env. Slack alerts wired in QA evaluator + macmini health-check.
**Requirements:** SECRETS-01..03
**Status:** Not started.
**Success Criteria:**
1. All 3 secrets provisioned + verified accessible by deployed CFs.
2. Sonnet-4-6 middle tier active in pa-resume-parser chain (verified via cv-ingest log of `tier_ok: secondary`).
3. Slack alert fires on QA evaluator failure threshold breach.

### Phase 70: Match-debug admin UI

**Goal:** New page `/admin/match-debug`. Admin enters userId → sees live V16 query result with full ScoreBreakdown + drop-counter visualization + per-job inspector. Score weight tuning sandbox.
**Requirements:** MATCHDEBUG-01..04
**Status:** Not started.
**Success Criteria:**
1. `/admin/match-debug` page deployed at `https://wekruit-pa.web.app/admin/match-debug`.
2. Adam can simulate his own match path + see all 7 hard-filter gate decisions.
3. Score weight slider sandbox functional (writes to `pa-match-weight-overrides/{userId}`).

### Phase 71: QA data ramp (auto-derive tags)

**Goal:** Auto-derive `targetRoleFunction` from CV skills+industries for users who haven't completed onboarding. Fill-gaps script. QA evaluator post-ramp re-trigger; verify sampleSize >50.
**Requirements:** QADATA-01..04
**Status:** Not started.
**Success Criteria:**
1. ≥80% of users with CV uploaded have `targetRoleFunction` populated (auto-derived if missing).
2. Phase 61 QA evaluator weekly run produces sampleSize ≥50.
3. Onboarding completion-rate widget on `/admin/overview`.

### Phase 72: Documentation v1.7

**Goal:** `CLAUDE.md` v1.7 design lock subsection. `.planning/MILESTONE-v1.7-match-depth.md` with architecture diagram + per-source data flow + sponsorship inference flow + match-debug screenshots.
**Requirements:** DOC-V17-01..02
**Hard prerequisite:** All 9 prior v1.7 phases shipped.
**Status:** Not started.
**Success Criteria:**
1. `CLAUDE.md` v1.7 section appended.
2. `.planning/MILESTONE-v1.7-match-depth.md` exists with full architecture + flow diagrams.
