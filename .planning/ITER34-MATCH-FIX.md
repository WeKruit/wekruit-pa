# Iter34 Match Pipeline Overhaul — RCA + Retro

**Date**: 2026-05-05
**Sprint**: iter34 (A.1 → C.20)
**Adam directive**: "SWE 候选人收到 Warehouse Team Lead 推荐 — 这他妈是疯子"

## 1. Symptom (用户层)

Adam 5/5 上午 iMessage live test (4 张截图), candidate persona = SWE
(Tesla / Node.js / React)。看到的问题:

| # | 现象 | 严重度 |
|---|------|--------|
| 1 | 推荐里出现 "Warehouse Team Lead", "Manager in Training", "Cashier" 之类完全不沾边的岗位 | P0 — match 不是疯子 |
| 2 | 推荐链接是 `jobright.ai/jobs/info/...` 镜像页, 不是真 ATS (greenhouse / lever / workday / ashby) | P0 — 用户点不进去 |
| 3 | 简历刚 upload 完几秒就推 match — 显然 CV 还没解析完 | P0 — pre-CV match |
| 4 | 每条 job 没解释为什么推荐 | P1 — black box |
| 5 | onboarding 完用户看不到自己被打了什么 tag (system 怎么理解他) | P1 — opaque |
| 6 | "拉匹配挂了" / "tomorrow ~9am" 这种 robot/leak phrase | P2 — voice |

## 2. RCA — 6 个 root cause

颗粒度问题。单文件单 PR 都 OK, 跨文件全链路过一遍才看见。

| # | Root cause | 文件 | 错在哪 |
|---|-----------|------|--------|
| 1 | match 在 CV 解析前触发 | `runtime-bridge.ts` `onResumeAccepted` | onboardingComplete 同 turn 同步触发 `generateJobRecs`, 但 cv-ingest 是 async enqueue, 几秒后才完成。match 拿到的是 statedPreferences 的瘦 profile, 没 CV 信号。 |
| 2 | targetRole 完全没传进 query | `orchestrator-deps.ts:218-250` | `statedPreferences.targetRole` 在 onboarding 里捕获了, 但 build `QueryMatchingJobsFilters` 时没 pass。queryMatchingJobs 永远不知道用户要做啥。 |
| 3 | `topSkills` 是 ghost field | `cv-ingest.ts` writer 路径 | `generateJobRecs` 读 `parsedCandidateResumes[uid].topSkills` 给 scoreJob, 但 cv-ingest **从来没写过**这个字段。永远 fallback `[]` → skill 维度 score = 0。 |
| 4 | 用 `primaryUrl` (jobright 镜像) 不用 `atsApplyUrl` | message compose path | Firestore `jobs.atsApplyUrl` 已 100% populated (Stage 2.5 跑完写满 2026-05-03), 但 wekruit-pa projection / compose 全程读 `primaryUrl`。结果用户拿到 jobright 转链。 |
| 5 | match 没语义信号 | `scoreJob` | jobs doc 已 store `embedding` (1536-d), 但 scoreJob 没读。纯靠 skill Jaccard + spons + loc + sal — 词面 overlap, 抓不到 "Node.js dev" ≈ "Backend Engineer" 这种语义近邻。 |
| 6 | message 没 reason | message compose | 输出只有 `title @ company \n url`。用户看不到为啥推这条。 |

## 3. 修复链 — 13 个 commit, 按 sprint 分组

### Sprint A — P0 ("match 不是疯子"), 8 iter

| # | Commit | What |
|---|--------|------|
| A.1 | `bb936fa` | cv-ingest writes `topSkills` from `candidateProfile.skills + workHistory`. Ghost field 不再 ghost。 |
| A.2 | `1ba52f9` | `atsApplyUrl > primaryUrl` across types / projection / compose / daily-batch。fallback to primaryUrl 仅当 atsApplyUrl 空。 |
| A.3 | `ee718af` | `targetRole` + `targetRoleIndustryEnum` 加入 `QueryMatchingJobsFilters`。 |
| A.4 | `8b1e6e6` | role-to-industry bucket mapper: 12 canonical roles (SWE, ML, PM, Designer, DataAnalyst, ...) → 4-bucket industryEnum arrays. |
| A.5 | `49e9170` | targetRole wired through `generateJobRecs` → `queryMatchingJobs`。Closes RCA #2。 |
| A.6 | `2a70add` | poll `parsedCandidateResumes` 5s × 18 = 90s before triggering match。Closes RCA #1。 |
| A.7 | `0baff37` | `composeInterimResumeAck` (24 variants × 3 langs) — 简历刚收到立刻 ack, 不让用户等 90s 黑屏。 |
| A.8 | `e46122d` | `formatCvSummaryForUser` — match 前先发一句"看下来你 Node.js + React + Tesla SWE 方向"让用户看到 system 的理解。Closes RCA #5 user-visible 部分。 |

### Sprint B — P1 ("match 真的准"), 5 iter

| # | Commit | What |
|---|--------|------|
| B.9 | `1ad7d2f` | CV embedding compute synchronously in cv-ingest (`lib/embeddings.ts` shared with daily-batch)。 |
| B.10 | `f2d76fc` | `cosineSimilarity` + scoreJob breakdown: skill 0.35 / emb 0.30 / spons 0.15 / loc 0.15 / sal 0.05。Closes RCA #5。 |
| B.11 | `6568956` | per-job "为啥推:" reason text using ScoreBreakdown。Closes RCA #6。 |
| B.12 | `9fff31a` | `industryEnum` (clean) preferred over `industryKey` (17% mislabel rate from Stage 1 LLM)。 |
| B.13 | `21ed498` | tech-leaning title regex anti-bias: drop warehouse / trucker / nurse / cashier 类 title 当 user targetRole ∈ {SWE, ML, PM, Data}。Hard cap on RCA #1 leakage path。 |

### Sprint C — Tests + Deploy

| # | Commit | What |
|---|--------|------|
| C.16 | `0afa4c1` | `eval-match-correctness-zh` + `-en` scenarios + harness scripts。 |
| C.17 | (deploy) | predeploy gate 全绿: build + smoke + typecheck + 476 functions tests + 315 job-rec tests + 1212 pa-orch tests = ~2000 全绿。 |
| C.18 | (deploy) | deploy 27 functions to `wekruit-5f89b` + firestore rules deploy。 |

## 4. Architecture diff

### Before

```
[user uploads resume]
  → onResumeAccepted hook
  → enqueue cv-ingest (async)
  → onboardingComplete 同 turn
  → generateJobRecs(瘦 statedPreferences profile)
  → queryMatchingJobs(filters: industryTags + skills + spons + loc + sal)
  → top-50 by firstSeenAt
  → score: Jaccard skill 0.5 + spons 0.2 + loc 0.2 + sal 0.1
  → top-2 → message: "title @ company \n primaryUrl"  (= jobright mirror)
```

Output for SWE candidate:

```
Warehouse Team Lead @ Walmart
https://jobright.ai/jobs/info/abc123
Manager in Training @ AutoZone
https://jobright.ai/jobs/info/def456
```

### After

```
[user uploads resume]
  → onResumeAccepted hook
  → composeInterimResumeAck (zh/en/mixed) 立刻发
  → enqueue cv-ingest (async)
    └ cv-ingest sync: parse → topSkills + embedding → write doc
  → poll parsedCandidateResumes (5s × 18 = 90s timeout)
  → if ready:
       formatCvSummaryForUser → "看下来你 Node.js + React + Tesla SWE — 推这方向"
     else:
       fallback "简历还在分析, 我先按你聊的方向找"
  → generateJobRecs:
       resolve targetRoleIndustryEnum from canonical role
       queryMatchingJobs(targetRoleIndustryEnum + cvEmbedding + ... )
         → applyEnrichmentNeverList (industryEnum-driven)
         → applyTargetRoleIndustryEnumFilter (post-filter ∩)
         → applyTechLeaningTitleBlacklist (regex drop)
         → top-50 by firstSeenAt
         → scoreJob: skill 0.35 + emb 0.30 + spons 0.15 + loc 0.15 + sal 0.05 → breakdown
       formatJobMatchReason(top job, lang) → "Node.js + React 命中, 方向对得上 SWE"
  → message: "title @ company \n atsApplyUrl \n 为啥推: <reason>"
```

Output for SWE candidate (expected):

```
Senior Software Engineer @ Stripe
https://boards.greenhouse.io/stripe/jobs/12345
为啥推: Node.js + React 命中, 方向对得上你 SWE; SF Bay 远程 OK

Backend Engineer @ Anthropic
https://jobs.lever.co/anthropic/abc-def
为啥推: Python + 分布式系统命中; AI infra 你简历里 Tesla autopilot 经历对口
```

## 5. Test coverage 数据

| Workspace | Baseline | Iter34 new | Total | All green? |
|-----------|----------|------------|-------|------------|
| pa-orchestrator | 1163 | 49 | 1212 | yes |
| functions | 461 | 35 | 496 | yes |
| job-rec | 288 | 27 | 315 | yes |
| **Total** | **1912** | **111** | **2023** | **yes** |

Predeploy gate: 全绿 → ship。

## 6. 已知 limitation / follow-up

| # | Issue | 影响 | Fix path |
|---|-------|------|----------|
| L1 | Harness observability gap | `tests/scenarios/runner.mjs` broker dedup 看不到 `send_cv_analysis` 分支前 3 条 (interim + analysis + jobRec), 只看到最后 1 条 tag-summary。Production iMessage **不受影响** (enqueueOutbound 路径独立), 但 dashboard 历史也只 1 条。 | append seq counter to idempotencyKey in `onboarding-deterministic.ts:2024` `sendDirect` |
| L2 | Pre-existing typecheck errors in `apps/job-rec` | `match-explainer-boost.test.ts:29` + `daily-batch.ts:1538` 共 2 个。**不阻塞** functions deploy 但应清理。 | 单独 follow-up commit |
| L3 | Stage 2.5 URL Resolution still SKIP_URL_RESOLUTION=1 | macmini Supabase pooler hang 没修。但 Firestore `atsApplyUrl` 100% 已 populated (2026-05-03 跑完写满)。新 jobs 进来时如果 Stage 2.5 仍 skip → atsApplyUrl 空 → fallback `primaryUrl` (jobright)。 | 见 `MACMINI-STAGE25-FIX.md` patches; 需 Adam 决策是否换 Supabase 直连 |
| L4 | CV embedding fail-open | cv-ingest 调 OpenAI 失败 (rate limit / 网络) → doc 仍写但无 embedding, 当天 match 没语义信号 (skill+spons+loc+sal 仍跑); daily-batch lazy compute 第二天兜底。 | 监控 metrics; 高 fail-rate 时考虑 retry |

## 7. 验收待 (Adam 真机)

- [ ] iMessage `__PA_RESET__` 走全流程
- [ ] 看到 interim ack ("简历收到, 我看一下")
- [ ] 看到 CV summary tag ("看下来你 ... 方向")
- [ ] 看到 match 推荐含 atsApplyUrl (非 jobright.ai)
- [ ] 看到 "为啥推:" 行
- [ ] 推荐 title 不是 warehouse / manager / cashier 类
- [ ] 推荐 industryEnum 含 tech_software / ai_ml / fintech_finance / tech_hardware

## 8. 复盘 (阿里四步)

**回顾目标**: SWE 候选人收到 SWE-aligned 推荐, 链接是真 ATS, 用户知道为啥推。

**评估结果**: 13 commit 落地 + 全栈 deploy + ~2000 单元测试绿; 真机验收待 Adam。

**分析原因**: 6 个 root cause 中 **4 个是"字段写但没用 / 用但没写"的连接失误** (topSkills, targetRole, atsApplyUrl, embedding) — 颗粒度问题。架构层意识不到, 因为单文件单 PR 都 OK, 只有跨文件全链路过一遍才看见。剩 2 个是时序 (RCA #1 pre-CV match) + 输出 (RCA #6 没 reason)。

**沉淀规律 (写进 `CLAUDE.md` SOP)**:
1. 每次新加 schema field → 同步 grep 所有 reader, 确认 reader 不会 fallback 到空。
2. 每次写 reader → 同步确认 writer 在哪, 不允许 ghost field。
3. 跨文件全链路 trace 必走: schema → writer → projection → reader → scoring → message compose, 一条都不能跳。

---

**Sprint C.20 docs/planning commit by P7 worker.** Adam closes loop on real-device verify checklist §7.
