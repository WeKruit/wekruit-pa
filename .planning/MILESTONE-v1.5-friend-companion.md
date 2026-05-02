# Milestone v1.5 — Friend-Companion Job-Rec System (production-grade)

**Spawned**: 2026-05-02 by P10 from Adam directive — v1.4 humanize-runtime BUILD shipped (paHumanizeRuntimeEnabled=true global), but daily push body still 人机, matching engine still on Mac mini, onboarding probe shallow, no message coalescing, no abuse hardening.

**Goal**: Convert Claire from "voice-good but flow-stiff job push bot" → **friend-toned recommender that talks like a roommate, knows you from CV alone, never floods, scales without Mac mini**. 14 Adam-stated streams unified under one milestone.

**Estimate**: ~15 dev-day execution + ~3 weeks soak with metrics gates.

**Status**: Scoping (P10 lock 2026-05-02).

---

## D-Series decisions (P10 strategic locks)

### D1 — Friend-tone CV-aware opener (replaces robotic "今天给你挑了 3 个")
- **What**: When user has CV but no stated preferences, opener references CV facts: "嘿没问过你具体想找啥，看你简历那段 NEUROVA Python+ML 挺硬，今天发现这 3 个对得上："
- **Where**: `apps/job-rec/src/daily-batch.ts` `formatDailyPushBody()` + new `DailyPushContext` type
- **Owner**: P7-H13 (in flight, rate-limited at 1:50am Chicago reset)

### D2 — Async cheap-LLM (Qwen-7B) match-explainer (per-job ground-truth reasoning)
- **What**: For each top-3 job in daily push, async call Qwen-7B (existing SiliconFlow) with (CV facts × JD × match score) → 1-sentence reason: "Senior PM at Stripe — 你 NEUROVA 的支付管线经验直接对得上 Stripe 的清算系统"
- **Constraint**: Async, fail-open (no reason → fall back to current logic). Adds 0 LLM calls to inbound conversation path; only daily-push pipeline.
- **Cost**: ~$0.0002/user/day at 100 users = $0.6/mo
- **Where**: New `apps/job-rec/src/match-explainer.ts` + cache in `pa-job-rec-explanations/{userId}/{jobId}` Firestore

### D3 — Tag-grouped recommendation (LightFM/implicit OSS, query by cluster)
- **What**: Replace per-user-per-day Firestore scan with: (a) precomputed user→tag-cluster mapping via embedding cosine, (b) per-cluster job recommender (LightFM hybrid), (c) per-user reranking. Reduces Firestore reads ~10x at 1k users.
- **OSS lib**: [LightFM](https://github.com/lyst/lightfm) (5.7k★, hybrid rec) OR [implicit](https://github.com/benfred/implicit) (3.8k★, ALS)
- **Phase**: Research first — verify CPU-only inference on CF Gen2

### D4 — Hard-filter respect (YoE / college / role-tag exclusivity)
- **What**: Before cross-encoder rerank, drop jobs where:
  - User is `yearsExperience < 1` (college student) AND job tagged `seniority_senior|staff|principal`
  - User CV has `industryTags=["research"]` AND job is non-research (industry_software_eng with no research keywords)
  - User stated `prefers_startup=true` AND job is FAANG (configurable boost not exclusion)
- **Where**: `apps/job-rec/src/tools/query-matching-jobs.ts` add `applyHardFilters(profile, jobs)` between `industryEnum` query and cross-encoder
- **Fallback**: If 0 jobs survive filters → fall back with "我看你简历目前还没找到完美的 fit，但这 3 个之前推过的方向你可以再考虑下："

### D5 — Onboarding probe v2 (rich Bible JOB-PREF natively triggered)
- **What**: Extend `onboarding.ts` state machine from 4 states → 8 states:
  - `pending` → `first_mes_sent` → `q_role` → `q_yoe` → `q_visa` → `q_startup_pref` → `q_location` → `complete`
- **Voice constraint**: Bilingual + friend-tone + ONE-question-at-a-time. Visa example: "那你有身份不？" (zh) / "btw — got work auth sorted? citizen / GC / OPT / need sponsorship?" (en). Never clinical.
- **Reusable**: Any user message that triggers `intent=job_search` AND `onboardingState != complete` reuses this flow without re-asking known fields.
- **Where**: Extend `packages/pa-orchestrator/src/onboarding.ts` + new `pa_users.onboardingFields` map (role/yoe/visa/startupPref/location/researchPref/salaryRange)

### D6 — Message coalescer (3 msgs → 1 reply, 3-5s tap-back)
- **What**: New CF `paMessageCoalescer` Cloud Task scheduled per inbound message with delay=3s. If next message arrives within 3s window → cancel previous task, reschedule with new combined input. Final task fires → orchestrator gets concatenated user input. Reply tap-backs the LAST user message (not first).
- **Constraint**: Hard cap 10s wait; force-fire if user typed > 5 messages.
- **Where**: New `apps/functions/src/coalesce/paMessageCoalescer.ts` — uses Cloud Tasks delayed-execution. Idempotency key = `${userId}:${turnSequence}`.
- **Migration**: Behind flag `paMessageCoalesceEnabled` (default off; ramp 1%→100%).

### D7 — Prompt injection / safety / abuse hardening
- **What**: Existing `pa_abuse_events` collection extend with:
  - `prompt_injection_detected` (regex + nl_judge for "ignore previous instructions" / "你现在是" / "DAN" patterns)
  - `illegal_content_request` (drug/weapon/CSAM keyword bans + escalate_to_admin)
  - `rate_abuse` (>20 inbound/min from one user → 1hr cooldown)
- **Action**: Add `safety-check.ts` BEFORE orchestrator; if flagged → respond with sanitized boilerplate + log + don't run LLM
- **OSS**: [LLM-Guard](https://github.com/protectai/llm-guard) for prompt-injection regex bank (5k★)

### D8 — Matching engine cloud migration (Mac mini → Cloud Run)
- **What**: `wekruit-matching` repo currently:
  - Mac mini at `/Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching`
  - Local Postgres + pgvector
  - launchd cron 6am CDT → `daily-update.sh` runs scrape + enrich + embed
  - `sync_jobs_bulk.py` writes results to Firestore
- **Target**:
  - Cloud Run service (4 vCPU, 4GB, scales-to-zero)
  - Cloud SQL Postgres + pgvector OR migrate to Firestore-only (decision in Phase 41 research)
  - Cloud Scheduler cron daily 6am UTC → triggers `/scrape-and-sync` endpoint
  - Sendblue notification webhook on job completion
- **Phases**: Phase 41 (audit + plan) → Phase 42 (Cloud Run port) → Phase 43 (Cloud SQL migrate or Firestore-only collapse) → Phase 44 (cron cutover + Mac mini decom)

### D9 — Reverse-match dashboard (JD+tags → candidates → outbound)
- **What**: Operator pastes JD + tags → reuse `query-matching-jobs.ts` reranker BACKWARDS (rank users against JD instead of jobs against user). Returns top-N candidates with match score. Operator clicks → trigger outbound via existing `pa-outbound`.
- **Where**: New `/dashboard/match-candidates` page + new CF `paReverseMatch?jobId=...&jdText=...&tags=[...]`
- **Reuse**: Cross-encoder rerank logic identical, just A/B swapped.

### D10 — Startup-vs-corp scoring boost
- **What**: When user CV has `companies[].industry includes "startup"` OR user stated `prefers_startup=true` → multiply company-startup match score by 1.3x in cross-encoder weighted blend. FAANG-experienced users default `prefers_corp=true` boost 1.2x for FAANG.
- **Detection**: Heuristic — companyName ∉ {Amazon, Google, Microsoft, Apple, Meta, Stripe, Snowflake, Databricks, OpenAI, Anthropic, top-50 enterprise} AND `companyEmployeeCount < 500` (from enrichment) → tag startup.
- **Where**: `apps/job-rec/src/cross-encoder-rerank.ts` adjust weighted blend.

### D11 — E2E QA team (multi-agent CN+EN parity)
- **What**: 4-agent pipeline:
  - Agent-UX: simulates user inbound (CN/EN/Spanglish) across 8 personas (college student / SWE 5y / PM 10y / researcher / new grad / designer / startup founder / non-tech-pivot)
  - Agent-Resume: feeds Adam's CV + 5 synthetic CVs through cv-ingest pipeline; verifies industryTags + skills extraction parity
  - Agent-Convo: 50-turn dialog drift + voice rubric judging via existing `tests/scenarios/judge.mjs`
  - Agent-Match: dispatches mock daily-push for each persona, verifies hard-filter respect
- **CI gate**: `npm run qa:v1.5` must pass before merge to main

### D12 — Multi-message coalescer + tap-back UX
- **Scope**: Subsumed by D6 (single-stream)

### D13 — User-stated-preferences storage
- **What**: New `pa_users.statedPreferences` map with:
  - `prefersStartup: boolean | null`
  - `targetRole: string[] | null`
  - `yoeRange: [number, number] | null`
  - `visaStatus: "citizen"|"gc"|"opt"|"sponsorship_needed"|"unknown"`
  - `targetLocations: string[] | null`
  - `salaryFloor: number | null`
- **Updated by**: onboarding probe v2 (D5) + every conversation that hits intent=preference_update
- **Read by**: `applyHardFilters` (D4) + cross-encoder weighting (D10)

### D14 — Friend-tone hard-skill probing (visa example)
- **Subsumed by D5** — onboarding probe v2 handles this in friend-tone bilingual

---

## Phase decomposition (Phases 41-50)

| # | Phase | Stream | Goal | Estimate |
|---|-------|--------|------|----------|
| 41 | Friend-tone CV-aware opener (P7-H13 land) | D1 | DailyPushContext + variants for CV-known/unknown users + 4 tests + LIVE rematch verify | 0.5d |
| 42 | Async match-explainer | D2 | match-explainer.ts + Qwen-7B SiliconFlow async + Firestore cache + flag-gate `paMatchExplainerEnabled` | 1d |
| 43 | Hard filters | D4 + D10 | applyHardFilters() + statedPreferences read + startup-vs-corp boost + 6 tests | 1d |
| 44 | Onboarding probe v2 | D5 + D13 | 8-state machine + statedPreferences map + visa-friend-tone copy + reusable on intent=job_search | 2d |
| 45 | Message coalescer | D6 | paMessageCoalescer CF + Cloud Tasks delayed exec + flag-gate + tap-back integration | 2d |
| 46 | Safety / abuse hardening | D7 | safety-check.ts + LLM-Guard regex + nl-judge + pa_abuse_events extend + dashboard panel | 2d |
| 47 | Matching engine cloud migration AUDIT + PLAN | D8 (research) | Read wekruit-matching deploy, Cloud Run port plan, Cloud SQL vs Firestore-only decision doc | 1d |
| 48 | Matching engine cloud PORT | D8 (build) | Cloud Run service + Cloud Scheduler + cutover + Mac mini decom playbook | 3d |
| 49 | Reverse-match dashboard | D9 | /dashboard/match-candidates + paReverseMatch CF + rerank reuse + outbound trigger | 1.5d |
| 50 | E2E QA team + CN+EN parity | D11 | 4-agent CI suite + 8-persona fixtures + 50-turn drift + Bible-rule violations | 2d |
| 51 | Tag-grouped rec (LightFM / implicit) | D3 | Research first (CPU-only on CF Gen2 verify), prototype, A/B vs current per-user scan | 2d |

**Total**: ~18 dev-days. **Ship gate**: All 11 phases through CI green + 1-week soak + rollback playbook for each.

---

## Adam-locked v1.5 constraints

- **No model escalation**: Async explainer = Qwen-7B (not gpt-4)
- **No new top-level package**: Extend existing `apps/job-rec/`, `packages/pa-orchestrator/`, `apps/functions/src/coalesce/`
- **All net-new behaviors flag-gated**: `paMatchExplainerEnabled`, `paMessageCoalesceEnabled`, `paOnboardingProbeV2Enabled`, `paReverseMatchEnabled`, `paHardFiltersEnabled`, `paStartupBoostEnabled`
- **Default off → 1% canary → 10% → 50% → 100%** per existing `BucketStrategy` cookbook
- **No regressions**: pa-orchestrator 235/235 + agent-registry 33/33 + job-rec must stay green
- **Cost ceiling**: Async explainer ≤ $5/mo at 100 active users

---

## Backlog (explicit deferrals to v1.6+)

- **Voice-call interface**: User asked for friend-tone; voice agent is ~v2.0
- **Group-chat support**: Single-user only for v1.5
- **Job-application autofill**: Out of scope; just rec, not apply
- **Salary negotiation coaching**: Mention but no playbook (Bible v8.0)
- **Long-context CV diff** (compare CV revisions): Future; v1.5 ingests ONE CV
- **Discord channel**: User mentioned "any client can consume" — Discord/Slack hold for v2

---

## Cross-reference

- **Daily push body example (CURRENT, robotic)**: "今天给你挑了 3 个 - 1. Senior PM Stripe SF - 2. ..."
- **Daily push body target (D1 friend-tone)**: "嘿没问过你具体想找啥，看你简历 NEUROVA 的 Python+ML 管线挺硬，今天发现这 3 个对得上：[1. Senior PM Stripe — 你支付清算那段经验直接对得上] ..."
- **Onboarding example (CURRENT, 1 question)**: "你最近怎么了，找我有什么事吗"
- **Onboarding target (D5)**: 6 progressive friend-tone questions over 3-5 turns, never clinical
