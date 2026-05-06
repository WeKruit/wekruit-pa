---
gsd_state_version: 1.0
milestone: v1.6
milestone_name: Unified Canonical Tags & Match Quality v1
status: defining_requirements
last_updated: "2026-05-05T22:00:00.000Z"
last_activity: 2026-05-05
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
---

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-05-05 — Milestone v1.6 started

## v1.6 — Unified Canonical Tags & Match Quality v1 (this milestone)

Spawned 2026-05-05 by Adam after iter34 sprint surfaced fragmented tag system as root cause of bad match quality (SWE candidate Adam recommended BDR / Account Manager / Warehouse Team Lead). Design conversation locked 16 decisions before any code dispatch.

**Architecture pivot:** previously matching used 4 fragmented tag sources (`statedPreferences` + `parsedCandidateResumes.industryTags` + `parsedCandidateResumes.topSkills` + `parsedCandidateResumes.embedding`). v1.6 unifies into single source `pa-users/{userId}.tags` with two orthogonal axes (`roleFunction` 17 + `industrySector` 42, no abbreviations).

**Foundation already shipped (iter34 G + H + I waves):**
- Wave A.1-A.8 (Sprint A P0): cv-ingest topSkills + atsApplyUrl + targetRole filter + role-to-industry map + CV gating poll + interim ack + tag surface
- Wave B.9-B.13 (Sprint B P1): sync CV embedding + emb cosine in scoreJob + per-job reason + industryEnum > industryKey + tech-leaning blacklist
- Wave C.14-C.20 (Sprint C verify+ship): scenarios + deploy + doc
- Wave D.1-D.6 follow-ups: idempotencyKey collapse fix + SWE persona seed + typecheck clean + ats gate + extended blacklist
- Wave G.1-G.4: Adam CV refresh + recency filter + liveness + backfill ATS CF + Qwen-7B llmRerank library
- Wave H.1-H.3: mergeUserTags lib (canonical schema) + 5 sim CR fixes + cv-ingest unified writes
- Wave I research: jobright industry truth (utm_campaign 17 = role function, NOT sector) + scraping repo audit (INDUSTRY_VOCAB 38 already exists, packages/shared-tags ready, packages/pa-resume-parser valet-port done)

**Real sim from G5 (deployed CF):** 4-message bundle works end-to-end (interim ack + CV summary + match recommendation + tag summary), but recommended jobs are categorically wrong (BDR + Account Manager for SWE) due to:
- CR1: CV-analysis Qwen-7B degenerates ("Docker × 60") — fixed in H.2 commit `6ffd184`
- CR2: BDR/Account Manager not in title blacklist — fixed in H.2 commit `6e5e7c1`
- CR3: orderBy firstSeenAt (Adam pointed out: hard filter post-fetch + raise cap is correct path, NOT changing orderBy) — needs revisit in v1.6
- CR4: G.4 llmRerank shipped but TODO comment, wired in H.2 commit `c187c50`
- CR5: cvEmbedding accepted by scoreJob but not passed in — wired in H.2 commit `d8e60e3`

**v1.6 scope replaces piecemeal CR fixes with structural fix:** unified canonical vocab + single tag source + filter-first-then-rank query + per-skill weight + LLM JD-CV match + QA evaluator thread.

## Accumulated Context

**Adam's CV (real test target):**
- userId: `e5d97cd8-1e1d-439d-8672-3008f8aeef2e`
- parsedCandidateResumes docId: `rQIqQEghvZLwVkMad2lJ`
- Refreshed by `scripts/refresh-adam-cv.mjs` (commit `6f1366e`): industryTags=`["tech_software", "ai_ml"]`, topSkills 12, embedding 1536d, ready for v1.6 sim

**LLM chain (locked):**
- Tier 1: `gpt-5.4-nano` (primary, 2 SDK retries)
- Tier 2: `claude-sonnet-4-6` (fallback on 5xx/timeout/rate, 2 SDK retries) ← **NEW** for v1.6, replaces gpt-4.1-mini
- Tier 3: `gpt-4.1-mini` (final fallback, 1 SDK retry)

**Stack already in place:**
- `packages/shared-tags` — 10-type canonical with mutexGroup + sha256 event ID + decay half-life + `ENTITY_KINDS` covers scraping-job/researcher/github-repo/devpost-project (iter30 WS2)
- `packages/pa-resume-parser` — 3-tier router + valet-port complete + `qabank-to-mem0.ts` (iter30 WS1)
- `packages/pa-orchestrator/src/tags/user-tags-merger.ts` — H.1 commit `253ce87` (`mergeUserTags` lib + UserTagsSchema zod)
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

Continue from v1.5 ending phase 51. v1.6 starts at phase **52**.
