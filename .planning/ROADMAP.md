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

## Phase 25: Voice Self-Evolve (DEFERRED to v1.3)

**Goal:** Global slang central evolution (weekly cron) + per-user STYLE.delta + 口头禅 (daily cron) + aeon-style autoresearch 4-variation generator + DeepEval gate + HITL PR review + Hermes-style prompt-injection scan.
Requirements: TBD (defer to v1.3 milestone scope)
**Status:** Backlog (deferred to v1.3 — do NOT execute this cycle).
**Hard dependency:** Phase 24 must close with all success criteria met (DeepEval CI green ≥75% on golden-50 for 2 consecutive weeks, Bible v6 + Qwen3.5-4B rewriter stable, telemetry stream emitting, Adam smoke test passes).
**Success Criteria**: See `phases/25-voice-self-evolve/25-CONTEXT.md` (frozen spec).

**Plans:** 0 plans (NOT planning this cycle — backlog)

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
