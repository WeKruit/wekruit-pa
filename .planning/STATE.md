---
gsd_state_version: 1.0
milestone: v1.6
milestone_name: Unified Canonical Tags & Match Quality v1
status: in_progress
last_updated: "2026-05-06T00:30:00.000Z"
last_activity: 2026-05-06
progress:
  total_phases: 11
  completed_phases: 6
  total_plans: 6
  completed_plans: 6
---

## Current Position

Phase: **Phase 58 — Nightly LLM rerank batch + per-skill JD-rel weight (next)**
Plan: —
Status: Phase 57 ✅ complete (commit `57c182b`) — paLivenessSweepDaily CF deployed + jobType normalize (253 jobs) + seniorityLevel backfill (1280/1684) + macmini Stage 2.5 hotfix verified (SKIP_URL_RESOLUTION=1) + macmini fresh ingestion synced +2,735 new jobs (759 tests pass); v1.6 in progress (6/11)
Last activity: 2026-05-06 — Phase 57 liveness + macmini probe + fresh ingestion shipped (LIVE-01..04 covered)
Adam-action items:
- Set `ANTHROPIC_API_KEY` Firebase Secret (Phase 53) — optional, chain falls through gracefully
- Daily-batch.ts cutover legacy → V16 deferred to Phase 60

## v1.6 — Unified Canonical Tags & Match Quality v1 (this milestone)

Spawned 2026-05-05 by Adam after iter34 sprint surfaced fragmented tag system as root cause of bad match quality (SWE candidate Adam recommended BDR / Account Manager / Warehouse Team Lead). Design conversation locked **16 decisions** before any code dispatch.

**Phase numbering:** continues from v1.5 last phase 51. v1.6 spans phases **52–62** (11 phases).

**Architecture pivot:** previously matching used 4 fragmented tag sources (`statedPreferences` + `parsedCandidateResumes.industryTags` + `parsedCandidateResumes.topSkills` + `parsedCandidateResumes.embedding`). v1.6 unifies into single source `pa-users/{userId}.tags` with two orthogonal axes (`roleFunction` 17 + `industrySector` 42, no abbreviations).

**Phases (52–62):**

| # | Phase | Reqs | Status |
|---|-------|------|--------|
| 52 | Canonical Tag Vocab Foundation | TAG-01..12 (12) | Not started |
| 53 | pa-resume-parser v2 wire + relevantTags extract | PARSE-01..09 (9) | Not started |
| 54 | Unified pa-users.tags writer | USER-TAG-01..05 (5) | Not started |
| 55 | matching-jobs schema migration + roleFunction backfill | MATCH-02 (1) | Not started |
| 56 | queryMatchingJobs read pa-users.tags + filter + score | MATCH-01, 03..08 (7) | Not started |
| 57 | Liveness/404 sweep + atsApplyUrl backfill | LIVE-01..04 (4) | Not started |
| 58 | Nightly LLM rerank batch + per-skill JD-rel weight | RERANK-01..04 (4) | Not started |
| 59 | Dashboards (canonical-tags + qa-evaluator + onboarding-questions ext) | DASH-01..04 (4) | Not started |
| 60 | Dev triggers + scenarios + fixtures | DEV-01..04 (4) | Not started |
| 61 | QA evaluator thread weekly run (final ship gate) | QA-01..05 (5) | Not started |
| 62 | Documentation (CLAUDE.md / MILESTONE-v1.6.md / cross-repo handoff) | DOC-01..04 (4) | Not started |

**Coverage:** 59/59 REQ-IDs mapped, no orphans, no duplicates.

**Eval-first ordering resolution:**
```
Phase 52 (vocab foundation, hard prerequisite for all)
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

**Foundation already shipped (iter34 G + H + I waves):**
- Wave A.1-A.8 (Sprint A P0): cv-ingest topSkills + atsApplyUrl + targetRole filter + role-to-industry map + CV gating poll + interim ack + tag surface
- Wave B.9-B.13 (Sprint B P1): sync CV embedding + emb cosine in scoreJob + per-job reason + industryEnum > industryKey + tech-leaning blacklist
- Wave C.14-C.20 (Sprint C verify+ship): scenarios + deploy + doc
- Wave D.1-D.6 follow-ups: idempotencyKey collapse fix + SWE persona seed + typecheck clean + ats gate + extended blacklist
- Wave G.1-G.4: Adam CV refresh + recency filter + liveness + backfill ATS CF + Qwen-7B llmRerank library
- Wave H.1-H.3: mergeUserTags lib (canonical schema) + 5 sim CR fixes + cv-ingest unified writes
- Wave I research: jobright industry truth (utm_campaign 17 = role function, NOT sector) + scraping repo audit (INDUSTRY_VOCAB 38 already exists, packages/shared-tags ready, packages/pa-resume-parser valet-port done)

**Real sim from G5 (deployed CF):** 4-message bundle works end-to-end (interim ack + CV summary + match recommendation + tag summary), but recommended jobs are categorically wrong (BDR + Account Manager for SWE). v1.6 scope replaces piecemeal CR fixes with structural fix: unified canonical vocab + single tag source + filter-first-then-rank query + per-skill weight + LLM JD-CV match + QA evaluator thread.

## v1.6 Goal Metrics (5)

1. SWE candidate Adam (`e5d97cd8-1e1d-439d-8672-3008f8aeef2e`) → BDR/sales/cashier/warehouse leak rate **100% → <5%**
2. jobright.ai-leaked match URL rate **50%+ → 0%**
3. Adam industryTags `["other"] → ["artificial_intelligence_and_machine_learning", "technology_general"]`
4. Per-job reasoning surfaces top-2 JD-aligned weighted skill matches
5. QA evaluator pass rate: hard filter ≥90%, top-3 acceptable **≥70%** weekly auto-sample

## Accumulated Context

**Adam's CV (real test target):**
- userId: `e5d97cd8-1e1d-439d-8672-3008f8aeef2e`
- parsedCandidateResumes docId: `rQIqQEghvZLwVkMad2lJ`
- Refreshed by `scripts/refresh-adam-cv.mjs` (commit `6f1366e`): industryTags=`["tech_software", "ai_ml"]`, topSkills 12, embedding 1536d, ready for v1.6 sim

**LLM chain (locked):**
- Tier 1: `gpt-5.4-nano` (primary, 2 SDK retries)
- Tier 2: `claude-sonnet-4-6` (fallback on 5xx/timeout/rate, 2 SDK retries) ← **NEW** for v1.6
- Tier 3: `gpt-4.1-mini` (final fallback, 1 SDK retry)

**Stack already in place:**
- `packages/shared-tags` — 10-type canonical with mutexGroup + sha256 event ID + decay half-life + `ENTITY_KINDS` covers scraping-job/researcher/github-repo/devpost-project (iter30 WS2)
- `packages/pa-resume-parser` — 3-tier router + valet-port complete + `qabank-to-mem0.ts` (iter30 WS1)
- `packages/pa-orchestrator/src/tags/user-tags-merger.ts` — H.1 commit `253ce87` (`mergeUserTags` lib + UserTagsSchema zod)
- `apps/functions/src/lib/llm-rerank.ts` — Qwen-7B JSON-mode (iter34 G.4); fire-and-forget wired (H.2 `c187c50`)
- `apps/functions/src/backfill-ats-urls.ts` — Serper backfill CF (iter34 G.3 `a56da02`)
- `apps/functions/src/cv-ingest/cv-ingest.ts` — already imports pa-resume-parser, partial wire (iter34 H.3b `ad099a2`)
- `tests/scenarios/runner.mjs` + `dump-outbound-tail.mjs` — Firestore broker integration with pa-outbound observability bypass

**Cross-repo state:**
- `wekruit-scraping/src/wekruit_matching/scraper/jobright_github.py` — `REPO_TO_CATEGORY` 1:1 with jobright `utm_campaign` 17 verbatim
- `wekruit-scraping/src/wekruit_matching/enrichment/classifier.py` — `INDUSTRY_VOCAB` 38 frozenset already in place
- macmini Stage 2.5 URL Resolution still hangs (Supabase pooler) — wekruit-pa CF backfill `paBackfillMatchingJobsAtsUrl` (commit `a56da02`) deployed as backup

**Match flow target after v1.6:**
```
queryMatchingJobs(userId):
  read pa-users.tags single source           ← D8 unified
  build filters from tags
  Firestore query:
    where status=active
    where roleFunction array-contains-any tags.roleFunction   ← D1 hard filter
    orderBy firstSeenAt desc                                  ← D10 (NOT lastSeenAt)
    limit 500                                                 ← raise cap (was 50)
  in-memory hard filter:
    visa intersect, location intersect, careerStage window, jobType exact
    firstSeenAt < 20d, atsApplyUrl present + not jobright, dead !== true
  soft score:
    LLM match (Qwen-7B nightly cache)         0.40
    skill jaccard (per-skill weight × jd-rel)  0.20
    relevantTags overlap                       0.15
    industrySector overlap                     0.10
    cv emb × jd emb cosine                     0.10
    salary fit                                 0.05
  output:
    title @ company \n atsApplyUrl \n 为啥推: <weighted reason>
```

## Phase Numbering

Continue from v1.5 ending phase 51. v1.6 starts at phase **52** and runs through phase **62** (11 phases).

## v1.6 Decision Log (D1–D16, Adam-locked)

D1: roleFunction = jobright 17 verbatim (closed enum) | D2: industrySector = 42 add-able via dashboard (sandbox→promote) | D3: major = soft score (not hard filter) | D4: visa = 4 enum (`citizen` / `permanent_resident` / `sponsor_needed` / `other`) | D5: NO abbreviations anywhere (LLM confusion) | D6: relevantTags / proposedTags parse-time extract | D7: per-skill base + JD-relative weight (Qwen-7B nightly) | D8: unified `pa-users.tags` single source | D9: hard filter → skill+relevant+industry score → LLM async → emb fallback | D10: 20d `firstSeenAt` window + 404 daily, abandon `lastSeenAt` | D11: cv-ingest wires `pa-resume-parser` v2 (not single-shot nano) | D12: post-parse Claire dialogue confirm | D13: QA evaluator thread weekly | D14: `__PA_FIND_MATCH__` dev trigger | D15: reduce regex, prefer LLM | D16: industry add-able via dashboard

## Next Action

Run `/gsd:plan-phase 52` to decompose Phase 52 (Canonical Tag Vocab Foundation) into executable plans.
