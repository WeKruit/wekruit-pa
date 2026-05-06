# Milestone v1.6 — Unified Canonical Tags & Match Quality v1

**Status:** All 11 phases shipped 2026-05-06. Ship-gate signal pending data.
**Spawned:** 2026-05-05 by Adam after iter34 sprint
**Closed:** 2026-05-06

## Why This Milestone Existed

iter34 sprint surfaced fragmented tag system as root cause of bad match quality (SWE candidate Adam was being recommended BDR / Account Manager / Warehouse Team Lead). Design conversation locked **16 decisions** (D1-D16) before any code dispatch.

## Architecture

```mermaid
flowchart TD
  cv[CV Upload<br/>iMessage attachment] -->|fire-and-forget| pi[cv-ingest CF]
  pi -->|parseResumeText| pp[pa-resume-parser v2<br/>gpt-5.4-nano → claude-sonnet-4-6 → gpt-4.1-mini]
  pp -->|sha256 idempotent| fs1[(parsedCandidateResumes)]
  pp -->|industries === ['other'] retry| pp
  pp --> mt[mergeUserTags]
  mt --> pu[(pa-users/{userId}.tags<br/>SINGLE SOURCE)]

  ob[Onboarding Chat] --> wo[writeOnboardingTags] --> mt
  reply[CV-confirm reply] --> ccr[cv-confirm-reply parser] --> mt

  pu --> q[queryMatchingJobsV16]

  mj[(matching-jobs<br/>roleFunction[] + industrySector[])] --> q

  q -->|filter chain| f[Hard Filter:<br/>visa → location → careerStage → jobType<br/>→ firstSeenAt<20d → atsApplyUrl → dead]

  f -->|score| s[Soft Score:<br/>llm 0.40 + skill 0.20 + relTags 0.15<br/>+ industrySector 0.10 + cvEmb 0.10 + salary 0.05]

  s --> top[Top-N output<br/>+ per-job reasoning<br/>top-2 weighted skills]

  cache1[(pa-user-rerank-cache)] --> s
  cache2[(pa-user-skill-jdrel-cache)] --> s

  rerank[paLlmRerankNightly<br/>04:00 UTC] --> cache1
  rerank --> cache2

  ls[paLivenessSweepDaily<br/>03:00 UTC] --> mj

  qa[paQaEvaluatorWeekly<br/>Mon 09:00 UTC] -->|sample 100| pu
  qa --> mj
  qa --> qarun[(pa-qa-evaluator-runs)]
```

## Two Orthogonal Axes

**Critical past mistake**: confusing `industry` and `function` as one axis. They are **orthogonal**.

- `roleFunction` — WHAT you do (jobright 17 utm_campaign verbatim). Hard filter axis.
- `industrySector` — WHAT KIND of company (42+ spelled-out, add-able via dashboard). Soft score axis.

A SWE at Stripe = `roleFunction='software_engineering'` AND `industrySector='financial_technology'`. Two independent.

## Vocab Tables

| Axis | Type | Count | Source File |
|---|---|---|---|
| roleFunction | closed enum | 17 | `packages/shared-tags/src/canonical/role-function.ts` |
| industrySector | closed + add-able | 42+ | `packages/shared-tags/src/canonical/industry-sector.ts` |
| major | closed enum | 69 | `packages/shared-tags/src/canonical/major.ts` |
| visa | closed enum | 4 | `packages/shared-tags/src/canonical/visa.ts` |
| jobType | closed enum | 10 | `packages/shared-tags/src/canonical/job-type.ts` |
| careerStage | closed enum | 13 | `packages/shared-tags/src/canonical/career-stage.ts` |
| location | closed enum | 175 | `packages/shared-tags/src/canonical/location.ts` |
| relevantTags | open vocab | unbounded (cap 12/profile) | `packages/shared-tags/src/canonical/relevant-tags.ts` |
| skills | bucketed open vocab | unbounded (10 buckets) | `packages/shared-tags/src/canonical/skills.ts` |

All values **lowercase + underscore**, **no abbreviations** (TAG-12 zod validation).

## Match Flow

```
queryMatchingJobsV16(userId):
  1. loadUserTags(userId)                                  ← single source
  2. Firestore query (push role to query):
       where status == 'active'
       where roleFunction array-contains-any user.targetRoleFunction
       orderBy firstSeenAt desc
       limit 500
  3. Hard post-filter (in-memory):
       visa intersect            (sponsor_needed × no-sponsorship → drop)
       location intersect        (anywhere bypass)
       careerStage adjacency window
       jobType exact intersect
       firstSeenAt < 20d         (NOT lastSeenAt)
       atsApplyUrl present + not jobright.ai
       dead !== true
  4. Soft score:
       llm_match (Qwen-7B nightly cache)         0.40
       skill_jaccard (per-skill base × jd-rel)    0.20
       relevantTags overlap                       0.15
       industrySector overlap                     0.10
       cv emb × jd emb cosine                     0.10
       salary fit                                 0.05
  5. Compose:
       title @ company \n atsApplyUrl
       为啥推: top-2 weighted matched skills
```

## Measurement Protocol

QA evaluator (Phase 61) Mon 09:00 UTC:
- Samples 100 user×match pairs (priority queue first)
- Per pair: Qwen-7B judge returns `{hardFilterPass, top3Acceptable, reasoning}`
- Aggregate rates → `pa-qa-evaluator-runs/{runId}`
- Alert (Slack + Mailgun) on `<90% hardFilter` OR `<70% top3`
- Ship gate: 2 consecutive passing runs

## Goal Metrics (5)

1. SWE candidate Adam → BDR/sales/cashier/warehouse leak rate **100% → <5%**
2. jobright.ai-leaked match URL rate **50%+ → 0%** (hard filter)
3. Adam industryTags `["other"] → ["artificial_intelligence_and_machine_learning", "technology_general"]`
4. Per-job reasoning surfaces top-2 JD-aligned weighted skill matches
5. QA evaluator pass rate ≥90% hard filter, ≥70% top-3 acceptable weekly auto-sample

## Open Items / v1.7 Backlog

- ANTHROPIC_API_KEY provisioning (chain falls through to gpt-4.1-mini gracefully)
- PA_SLACK_ALERT_WEBHOOK provisioning (Mailgun-only fallback active)
- Daily-batch.ts cutover deferred legacy → V16 (done in P60)
- macmini Stage 2.5 url_resolver permanent fix (currently hotfix-skipped)
- More users complete onboarding so `targetRoleFunction` populates → ship gate gets real signal
- Cross-repo Python port (deferred to v2.0)
