# iter30 — discussion synthesis

> ## ⚠️ ADAM DECISIONS 2026-05-03 (SUPERSEDES SECTIONS BELOW WHERE CONFLICTING)
>
> **Read this first. The body below was the v0 proposal; Adam's corrections lock the actual direction.**
>
> ### Decisions on §1 parseResume
> - **Parse LLM**: stay on **gpt-5.4-nano** primary with **structured output** (Responses API JSON schema). Fallback chain `gpt-4.1-mini → gpt-4.1-nano`. **NO Sonnet 4.5** (too expensive for what is a structured-extraction task). Optional: Anthropic structured output as second-tier fallback if needed for hard PDFs.
> - All 4 limits (gate / quota=2 / size=5MB / retry) confirmed.
> - qaBank→mem0 with mem0Add signature fix confirmed.
>
> ### Decisions on §2 tag ontology
> - Tags **can be English-only**. Adam: "tag可以是纯英文" — drop bilingual display layer, just have one canonical English form.
> - Tags **must be mutually exclusive** (a user has one canonical preference, not "prefer ML" + "prefer machine learning" both).
> - 3-layer architecture confirmed (alias-table → LLM normalize → BGE-M3 cosine + HDBSCAN discovery).
> - Self-curated dictionary, **don't import** ESCO / Lightcast / LinkedIn.
> - **LLM normalize uses FREE Qwen2.5-7B-Instruct on SiliconFlow** — NOT DeepSeek-V4-Flash. Adam corrected: Qwen-7B is currently free tier on SiliconFlow.
>
> ### Decisions on §3 DeepSeek V4-Pro
> - **DROPPED ENTIRELY**. Adam: "v4 pro没必要了，因为nano便宜特别多". Reasoning:
>   - gpt-5.4-nano: $0.20/M input, $1.25/M output (per OpenAI pricing screenshot)
>   - DeepSeek V4-Pro post-promo: $1.74 / $3.48 — 4-9× more expensive
>   - Stack already on `@openai/agents` SDK
> - **Stay on gpt-5.4-nano for Bible main turn**. Don't kill rewriter unless we get a better reason.
> - **For async parse jobs use OpenAI Batch API** (50% cheaper) — cv-ingest qualifies as it's not turn-blocking.
>
> ### Decisions on §5 boost calculator + dashboard
> - **Do it all at once now** (not phased). Migrate match-weights.ts → Firestore + dashboard editor in one shot.
> - Dashboard launch is **time-critical**: Adam will demo to business team SOON, so this UI must be polished, not stubby.
>
> ### Decisions on §6 explainer
> - **Research how industry does explainability for matching** (LinkedIn "Why this match" / Indeed "matched skills" / Hired / Vettery). Match the bar.
> - **Dashboard linked**: explainer output should also be visible in dashboard for operators to spot-check.
>
> ### Decisions on §7 playbook execution
> - **Skill-style approach is primary**: LLM intent classifier → find skills → combine skills.
> - **LLM intent fallback uses FREE Qwen2.5-7B-Instruct**, not DeepSeek-V4-Flash. Basically free.
> - **Regex stays as basic floor** (e.g. crisis keywords, AB-NEVER blocks) but is **NOT** the primary routing mechanism. Adam: "regex 这个我觉得我还是不太喜欢。因为太死板".
> - LLM holistic intent judgment is the lead, regex is the safety net.
>
> ### Decisions on §8 guardrails + RunContext
> - InputGuardrail / OutputGuardrail wrap: confirmed, "this is critical, think through carefully".
> - RunContext<ClaireContext>: confirmed, "you have to add too".
>
> ### Decisions on §10 dashboard playbook ops
> - All proposed features confirmed.
> - **Combined with §5 boost dashboard** as the same biz-team launch target.
>
> ### Decisions on §11 skills migration
> - Confirmed.
> - **The skill approach IS the playbook approach going forward** (intent → skill → compose).
>
> ### Decisions on §12 13 new playbooks
> - All 13 confirmed (Tier 1 + Tier 2 + Tier 3).
>
> ### Effort & sequencing
> See `PLAN.md` (separate file) — workstreams + engineer-agent assignments.

---

**Date**: 2026-05-03
**Adam directives** (most recent turn):
1. parseResume 像 valet 完善, 直接用就好, 限制 2 PDF + size + retry, qaBank → mem0
2. tagKey 怎么做 unsupervised, prefer ML / prefer machine learning 怎么 dedup
3. 切 DeepSeek V4 Pro
4. 继续做 (前一轮的 boost calc / explainer / guardrails / RunContext / dashboard / 13 个 playbook)
5. 派 team 调研 + async pipeline 跨仓共享 (PA + scraping)

4 个 agent **闭环**, 详细文档:
- [valet-integration.md](./valet-integration.md) — 713 行 — VALET parseResume audit + 集成方案
- [tag-ontology-research.md](./tag-ontology-research.md) — 769 行 — Tag ontology + 跨仓 unify + async pipeline
- [deepseek-v4-pro-migration.md](./deepseek-v4-pro-migration.md) — 380 行 — DeepSeek V4 Pro audit + PA 迁移决策
- [skills-vs-playbook-research.md](./skills-vs-playbook-research.md) — 655 行 — Skills 模式调研 + hybrid Zod schema

---

## 0. Adam 问题 → 文档对照

| Adam 问 | 答 在哪 |
|---|---|
| Q1 parseResume 完善 + 限制 + qaBank→mem0 | [valet-integration.md](./valet-integration.md), 本文 §1 |
| Q2 tagKey unsupervised dedup | [tag-ontology-research.md](./tag-ontology-research.md), 本文 §2 |
| Q3 DeepSeek V4 Pro 切 | [deepseek-v4-pro-migration.md](./deepseek-v4-pro-migration.md), 本文 §3 |
| 前轮 5 boost calculator + dashboard 权重 | 本文 §5 (新写) |
| 前轮 6 explainer 考虑 boost 权重 | 本文 §6 (新写) |
| Playbook 怎么执行 + 多 playbook 组合 | [skills-vs-playbook-research.md](./skills-vs-playbook-research.md), 本文 §7 |
| InputGuardrail / OutputGuardrail / RunContext | 本文 §8 (新写) |
| 统一 profile 维护 (跨仓) | [tag-ontology-research.md](./tag-ontology-research.md), 本文 §9 |
| Dashboard 怎么操控 playbook | 本文 §10 (新写) |
| Skills 用法参考 | [skills-vs-playbook-research.md](./skills-vs-playbook-research.md), 本文 §11 |
| 13+ playbook 场景写上 | 本文 §12 (新写) |
| 整体 sequencing | 本文 §13 |

---

## 1. parseResume — VALET 集成 (Adam Q1)

**结论**: 选 **Option B (port, 不 call-as-service)**. 8-11 dev-days.

**狠真相**:
- `apps/job-rec/src/tools/parse-resume.ts` = 空 stub
- `apps/functions/src/cv-ingest/cv-ingest.ts` = `gpt-5.4-nano` 单次 call, 无 fallback, 无 retry, 无 byte cap (只有 page cap 50)
- `webhook.ts` 见 `media_url` 就 fire ingestCv, **零 gating, 零 quota**
- `packages/memory/src/mem0.ts:304 mem0Add()` 只传 `{userId}`, **吞 metadata** — qaBank→mem0 必须先扩签名

**4 条限制规格**:

| 约束 | 实现 |
|---|---|
| Gate | `pa-users/{userId}.resumeAccepted = {at, expiresAt: at+24h, triggerHash}`. Claire 回复后 regex hook 写, ingestCv 入口读 (~10ms). 双语 regex 银行 (set + reject) |
| Quota 2/lifetime | `pa-users/{userId}.resumeParseCount` `FieldValue.increment(1)` 写后. 第 3 次拒文 zh/en 双语 |
| Size 5MB | HEAD-then-bounded-GET 在 parse 入口 (不在 webhook, 保 tapback ❤️ UX). 典型 200KB-1MB; design-heavy 2-4MB; image-PDF >5MB extract 反正失败 |
| Retry | 3-tier router (Sonnet 4.5 → gpt-4.1-mini → gpt-4.1-nano), 2× SDK retry × 3-tier × 包外 3 次 [1s/4s/16s]. Idempotency = sha256(bytes) |

**风险**: Sonnet 4.5 比 nano 贵 15× ($0.015 vs $0.001/CV). `PA_RESUME_PARSER_TIER` env 默认 mid 不顶 Sonnet.

**Schema 增**: `summary`, `workAuthorization`, `projects[]`, `certifications[]`, `languages[]`, `awards[]`, `volunteerWork[]`, `interests[]`, `websites[]`, `parseConfidence`, 分离 `bullets[]`, 计算 `totalYearsExperience`, `inferredAnswers[]` (qaBank).

**qaBank → Mem0**:
- 扩 `mem0Add(userId, content, metadata?)` 签名 — 当前吞 metadata
- `agent_id="claire"` 命名空间
- dedupe = sha256(userId::question) hash + Mem0 自带语义 dedupe
- intentTag 通过 question-pattern regex 银行映射 (preference / experience / authorization / aspiration / etc)

---

## 2. Tag ontology + 跨仓 unify (Adam Q2 + 跨仓共享)

**结论**: **3-layer hybrid, 不接外部 taxonomy** (不接 ESCO / Lightcast / LinkedIn). 自维护字典, 双语优先.

### 2.1 业界调研要点
- **ESCO** 免费 CC-BY 4.0, 28 语言**无中文**官方 (TalentCLEF 2025 社区有 zh 翻译). ❌ 中文体验差
- **LinkedIn Skills Graph** 39k skills × 374k aliases × 26 locales **含 zh-CN**, but **企业 only $50k-300k/yr**. ❌ 钱
- **O*NET** 1k occupations, en + es only. ❌
- **Lightcast Open Skills** 32k, freemium, 中文弱. ❌
- **JobBERT-v2/v3** TalentCLEF 2025 multilingual incl 中文, MIT license. ✓ 备选
- **BGE-M3** PA 现已 wired, beats OpenAI text-embed-3 on MIRACL multilingual. ✓ **就用它**
- **DeepSeek-V4-Flash** SiliconFlow $0.14/$0.28 per M tokens. ✓ 用作 normalize LLM
- **Cosine 阈值** 0.85-0.90 sweet spot for semantic dedup

### 2.2 3-layer 架构

```
[1] hot alias-table (in-memory, 50ms TTL refresh)  ← 99% hit 走这里
       ↓ miss
[2] LLM normalize (DeepSeek-V4-Flash, single call)   ← 0.5% 走这里
       ↓ miss / low-confidence
[3] BGE-M3 cosine + HDBSCAN discovery (worker async) ← 新 canonical 入字典
```

**关键**: 不要 realtime 调 LLM normalize. 先查本地 alias table → miss 入队列 async 处理.

### 2.3 3 个新 Firestore collection

| Collection | 角色 | 写者 |
|---|---|---|
| `pa-canonical-tags/{tagKey}` | 字典: `{key, displayZh, displayEn, aliases[], type, embedding[1024], confidence, evidence[], updatedAt, source}` | worker only |
| `pa-tag-events/{eventId}` | append-only 事件流: `{userId or jobId, rawTag, source, sha256, observedAt}` | **PA + scraping 都写** |
| `pa-entity-tags/{entityId}/items/{tagKey}` | denormalized 索引 (供 query): `{tagKey, confidence, firstSeen, lastReinforced, count}` | worker only |

### 2.4 Write 合约
```typescript
// 共享 lib (新 package: @wekruit/shared-tags)
recordTagEvent({
  userId?: string,         // PA: user msg 出标
  jobId?: string,          // scraping: job 抓出标
  rawTag: string,          // "prefer ML" / "machine learning" / 偏好机器学习
  source: "pa-realtime-tagger" | "pa-cv-ingest" | "scraping-github" | "scraping-devpost" | ...,
  evidence?: string,       // optional: 上下文 ≤500 char
})
// → idempotency key = sha256(rawTag::source::entityId)
// → onWrite trigger 启动 worker
```

### 2.5 Async pipeline
**Firestore onWrite trigger** (Option A) 不 Pub/Sub:
- 复用现 Cloud Functions Gen2 stack
- onWrite `pa-tag-events/{eventId}` → worker 处理
- worker 80 行伪代码已在 [tag-ontology-research.md](./tag-ontology-research.md)

### 2.6 成本
**12k events/day** (PA 1k user × 5 turn × 2 tag + scraping 1.4k/day): **~$0.87/mo** end-to-end. 230× ROI vs operator 人工.

### 2.7 Phasing (6-7 周, 单工程师)
| Phase | 周数 | 内容 |
|---|---|---|
| P1 | 1-2w | schema 落 + recordTagEvent 共享 lib + PA realtime-tagger 改写到新合约 |
| P2 | 2-3w | worker 上线 + alias-table 种子 (从现 industry-tags.ts 10-tag enum + 250 alias 起步) + DeepSeek-V4-Flash normalize ramp |
| P3 | 1-2w | backfill 现 Firestore data + scraping 写新合约 |
| P4 | 1w | discovery (HDBSCAN) + operator UI (dashboard) |

---

## 3. DeepSeek V4 Pro (Adam Q3)

**结论**: **只 swap Bible 主路, 不 bulk migrate**. 所有其他站点保留 Qwen-7B.

**先纠前提** (3.25 自检): Bible 主路实际跑 **OpenAI gpt-5.4-nano** 不是 Qwen-7B (`seed.json:7-8`). Qwen-7B 只跑 rewriter / 翻译 / explainer. 之前我和你说全 Qwen-7B 错了, 颗粒度不对.

### 3.1 价格关键

| 模型 | Input/M | Output/M | 备注 |
|---|---|---|---|
| gpt-5.4-nano (现 Bible 主路) | ? | ? | **价格不在 cost-logger.ts:73 表里, Adam 帮我确认** |
| DeepSeek V4 Pro (促销至 2026-05-31) | $0.435 | $0.87 | 75% off, 28 天后到期 |
| DeepSeek V4 Pro (post-promo 2026-06-01+) | $1.74 | $3.48 | 4× 涨价, plan 这个不 plan promo |
| Qwen2.5-7B-Instruct (SiliconFlow) | $0.05 | $0.05 | 现 helper 跑这个 |

### 3.2 PA 调用站点 swap/keep

| 站点 | 现模型 | 决策 | 理由 |
|---|---|---|---|
| Bible 主路 (orchestrator turn) | gpt-5.4-nano | **SWAP V4 Pro** | 真红利不是付钱, 是**主路换好模型 + 砍 rewriter**, 省 1.5-4s 延迟 |
| rewriter | Qwen-7B | **DELETE if SWAP works** | rewriter 只为补 nano 临床味. 主路好了不需要 |
| match-explainer | Qwen-7B | KEEP | daily-budget $1/day, V4-Pro 贵 35× 不值 |
| lang-lock translator | Qwen-7B | KEEP | fail-open, latency-sensitive |
| LLM-judge benchmark | gpt-5.4-nano | KEEP | 离线 eval, 价已固 |

### 3.3 GO 门 (CLAUDE.md iter23 写死的)
- V4-Pro-no-rewriter 跑 **10-turn long-context voice eval**
- ≥3/4 voice 维度赢 nano+rewriter
- p99 < 6s (现 ~12s budget, V4-Pro 据 Artificial Analysis 估 ~3-4s 单 turn)

### 3.4 成本投影
| 规模 | 今天 | 促销期 | post-promo |
|---|---|---|---|
| 100 user × 30 turn/day | ~$3/mo | ~$20/mo | ~$78/mo |
| 1000 user (公开) | ~$30/mo | ~$200/mo | **~$780/mo** |

1000-user 后 $780/mo 是 Adam "AS LOW AS POSSIBLE" 偏离的红线, **公开 launch 前必须有第 4 阶段降本** (e.g. fallback Qwen-7B for vent/casual turn, only V4-Pro on hard intent turn).

### 3.5 Adam 解锁项
1. 配 `DEEPSEEK_API_KEY` GCP secret (代码 `packages/agent-runtime/src/openai-provider.ts:16-21` 已支持)
2. `apps/functions/src/instrumentation/cost-logger.ts:73` 加 `deepseek-v4-pro` / `deepseek-v4-flash` 价格行 (现 unknown-model fallback 漏算 11×)
3. 给我 gpt-5.4-nano 公开价格

---

## 4. userId 一致性 + camelCase (Adam Q2 + Q3 from 上轮)

**已确认**:
- `pa-users.id` 是 PA canonical UUID
- `pa-job-profiles/{userId}` 引用同一 userId
- `pa-candidate-resumes/{userId}` 引用同一 userId
- PA 与 VALET user 系统**隔离** (VALET 用 Postgres + 自己 user table, PA 用 Firestore)
- camelCase 扫描: 核心 schema 无 snake_case 违反 (零 hit on `[a-z]+_[a-z]+:[ ]*z\.`)

**未来 valet 集成时要注意**: 如果 port VALET schema 进 PA, snake_case 字段名 (`work_history`, `parse_confidence`) 必须改 camelCase. Agent A 报告里提了.

---

## 5. Boost calculator + dashboard 权重管理 (Adam #5)

### 5.1 现状
`apps/job-rec/src/match-weights.ts` 是**硬编码 TS table** `AI_AGENT_SKILL_WEIGHTS`. 改一条得 deploy. dashboard 不可编辑. **底层逻辑错** — 权重是产品参数, 不该编译进代码.

调用站点:
- `apps/job-rec/src/cross-encoder-rerank.ts:450 applyStartupBoost`
- `apps/job-rec/src/match-weights.ts:210 applyWeightedMatchBoost`
- `apps/job-rec/src/daily-batch.ts:1363, 1462` (boost 链跑这里)

### 5.2 设计: BoostCalculator class + Firestore weight table

**新 collection** `pa-match-weights/{tableKey}/items/{skillKey}`:
```typescript
type WeightRow = {
  skill: string,            // lowercase substring match (legacy compat)
  skillCanonical: string,   // FK to pa-canonical-tags (forward-compat)
  weight: number,           // 0.5 - 3.0
  category: "core" | "supporting" | "generic",
  market: "ai-agent-2026" | "fullstack-2026" | "data-eng-2026" | ...,
  updatedAt: Timestamp,
  updatedBy: string,        // operator email
  reason: string,           // audit trail
}
```

`pa-match-weight-tables/{tableKey}` (table metadata):
```typescript
{
  name: "AI agent / LLM application engineer (2026)",
  description: "...",
  active: true,
  defaultForRoles: ["ai engineer", "llm engineer", ...],
  rowCount: 30,
  updatedAt: Timestamp,
}
```

**BoostCalculator class** (新文件 `apps/job-rec/src/boost-calculator.ts`):
```typescript
class BoostCalculator {
  constructor(private firestoreCache: FirestoreCache /* 30s TTL like playbook */) {}

  async loadTable(tableKey: string): Promise<WeightRow[]> { ... }

  computeWeightedMatchScore(
    cvSkills: string[],
    requiredSkills: string[],
    table: WeightRow[],
  ): { score: number, hits: WeightHit[], coreMissing: string[] }

  applyBoost<J extends { skills: string[] }>(
    jobs: J[],
    cvSkills: string[],
    table: WeightRow[],
    baseScores: number[],
  ): { reordered: J[], scores: number[], explainerInputs: BoostExplainerInput[] }
}
```

### 5.3 Dashboard 权重编辑 UI
新 page `/match-weights`:
- 列表: 所有 `pa-match-weight-tables/*`
- Table 详情: 行内编辑 weight (slider 0.5-3.0), category (dropdown), reason (text)
- "Add row" / "Remove row" / "Duplicate table to new market"
- "Test against sample CV" — 输入 CV skill list, 输出 boost 排序前后对比

### 5.4 Migration
1. seed Firestore from current `match-weights.ts` const (one-shot script)
2. `applyWeightedMatchBoost` 改读 BoostCalculator.loadTable
3. flag `paWeightsFromFirestore` 默认 OFF, 每个市场分批切
4. delete TS const 当所有市场切完

---

## 6. Explainer 考虑 boost 权重 (Adam #6)

### 6.1 现状
`apps/job-rec/src/match-explainer.ts` 收 `ExplainerCv` (recentRoleTitle / topSkills / etc) + 跑 Qwen-7B 出 1-2 句中文 "为什么 match". **不知道 boost 给的 hit 是 core 还是 generic**, 所以可能写 "你 Python match 很好" 但实际是 generic 命中.

### 6.2 设计: 新 ExplainerInput 字段 `boostHits`

```typescript
type BoostExplainerInput = {
  hits: Array<{
    skill: string,
    category: "core" | "supporting" | "generic",
    weight: number,
    matchedAgainst: "cv-skill" | "cv-bullet" | "title",
  }>,
  coreMissing: string[],
  totalBoostMult: number,   // 1.0-3.0
}
```

### 6.3 新 prompt directive
```
EXPLAINER 必须:
- 优先提 core-category hit (weight ≥ 2.0). e.g. "你做过 RAG 和 tool calling 这两个是核心 match"
- generic-only match 不能说 "match", 改说 "底子有但不是核心" e.g. "Python TS 这些底子有, 但 RAG / function calling 这种核心还没碰过"
- coreMissing 长度 ≥ 2 时, 提一个具体 missing: "如果你能补上 vector database 这块, 推这个就稳了"
```

### 6.4 Effort
~1 day. explainer.ts 改 prompt + 加 boost-hit 字段 + reset cache.

---

## 7. Playbook 执行 + 多 playbook 组合 (Adam playbook Q)

**结论**: **hybrid intent+regex**, 不纯 regex. 多 playbook 串行 concat addendum.

### 7.1 现状
- 6 个 playbook, 入口 `match-cached-playbooks.ts`
- regex 第一关 — 命中 → addendum inject
- 多个 regex 同时命中 → 按 priority 序 concat addendum
- 不命中 → bare Bible (无 playbook)

### 7.2 hybrid 架构

```
inbound msg
    ↓
[1] regex first-pass (0 latency, deterministic)
    → hit any? → 收集所有 hit playbook
    ↓
[2] LLM intent fallback (gated)
    gate: regex 全 miss AND msg 长度 > 30 token AND user 历史 ≥ 3 turn
    → 1 个 cheap LLM call (DeepSeek-V4-Flash, ~$0.0001) 分类到 6+ 个 playbook
    ↓
[3] composability check
    →  composableWith 列表里允许的 playbook 都进 stack
    →  conflict (e.g. vent_support 不与 jd_roast 同时) 按 priority 取一个
    ↓
[4] addendum concat by priority
    → systemInputs 附加到 prompt
```

### 7.3 多 playbook 组合 (Adam 例: 焦虑 + jd_roast)
**允许同时**:
- `vent_support` + `jd_roast` (Adam 例: 用户焦虑同时想吐槽 JD)
- `interview_prep` + `negotiation` (面完拿到 offer)
- `headhunter` + `vent_support` (想换工作 + 累)

**不允许同时**:
- `vent_support` + `motivation_nudge` (情绪场景互冲)
- `jd_roast` + `interview_prep` (吐槽 vs 准备 互冲)

**机制**: playbook schema 加 `composableWith: string[]` + `conflictsWith: string[]`. composable 集合内全 concat, conflict 取最高 priority.

### 7.4 LLM intent fallback 设计
**只在 regex 全 miss 时调** (~1% turn). 单 call 分类:
- input: user msg + 现 6 playbook 的 description (each 1 行)
- output: JSON `{ playbookKey: string | "none", confidence: number }`
- model: DeepSeek-V4-Flash $0.14/$0.28 per M, 单 call ~$0.0001
- timeout: 1s, fail-open (miss = 走 bare Bible)

### 7.5 与 OpenAI Agents SDK 关系
SDK 没 "playbook" 抽象. 我们自己的. SDK 提供 Agent / Tool / Handoff / Guardrail / RunContext — playbook 是 system prompt 注入, 与 SDK 平行不冲突.

---

## 8. InputGuardrail / OutputGuardrail / RunContext (Adam playbook Q)

### 8.1 现状
PA 已用 `@openai/agents@^0.8.5`. 但目前没用 SDK 的 guardrail. 现"过滤"逻辑散在 `output-normalizer.ts (AB strip + slang inject)`, `crisis-trailer.ts`, `vent-suspend.ts`. 各自一段 monkey-patch.

### 8.2 InputGuardrail 设计

包装现有逻辑成 SDK guardrail:

```typescript
import { InputGuardrail, GuardrailResult } from '@openai/agents';

const crisisInputGuardrail: InputGuardrail = async (ctx, input) => {
  const text = typeof input === 'string' ? input : input.text;
  const isCrisis = CRISIS_REGEX_BANK.test(text);  // 现 keywords
  if (isCrisis) {
    return { tripped: true, reason: 'crisis_detected', metadata: { ... } };
  }
  return { tripped: false };
};

const lengthInputGuardrail: InputGuardrail = async (ctx, input) => {
  const text = typeof input === 'string' ? input : input.text;
  if (text.length > 4000) return { tripped: true, reason: 'msg_too_long' };
  return { tripped: false };
};

const piiInputGuardrail: InputGuardrail = async (ctx, input) => {
  // SSN / 银行卡 / passport regex
  // 命中 → tripped=true → 拒绝处理
};
```

### 8.3 OutputGuardrail 设计

```typescript
const abStripOutputGuardrail: OutputGuardrail = async (ctx, output) => {
  const stripped = stripABProbeFromTail(output.text, ctx.locale);
  if (stripped !== output.text) {
    return { tripped: true, suggestedOutput: stripped, reason: 'ab_probe_stripped' };
  }
  return { tripped: false };
};

const slangInjectOutputGuardrail: OutputGuardrail = async (ctx, output) => {
  // 卧 → 卧槽 (Adam 偏好)
  const fixed = enforceSlangFullForm(output.text);
  if (fixed !== output.text) return { tripped: true, suggestedOutput: fixed };
  return { tripped: false };
};

const lengthCapOutputGuardrail: OutputGuardrail = async (ctx, output) => {
  const sentences = splitSentences(output.text);
  if (sentences.length > 3) return { tripped: true, suggestedOutput: sentences.slice(0,3).join('') };
  return { tripped: false };
};
```

**关键收益**: 散在 monkey-patch 收口到 SDK guardrail 链, 顺序明确, 单元测试 isolation.

### 8.4 RunContext<T> 设计

现 turn-state 散在 globals + Firestore 读写. 用 SDK 的 `RunContext<UserCtx>` 收口:

```typescript
type ClaireContext = {
  userId: string,
  locale: 'zh-CN' | 'en-US' | 'mixed',
  agentId: string,
  conversationId: string,
  turnId: number,
  // playbook 状态
  activePlaybooks: PlaybookKey[],
  // user profile (cached for turn lifetime)
  userProfile: {
    role?: string,
    yoe?: number,
    visa?: string,
    location?: string,
    preferences: PreferenceTags[],  // from pa-entity-tags
  },
  // mem0 quick-access
  memorySnapshot: MemoryEntry[],
  // boost weights cached this turn
  weightTables: Record<string, WeightRow[]>,
  // crisis flag
  crisisTripped: boolean,
  // resume state
  resumeAccepted: boolean,
  resumeParseCount: number,
};

// 用法
const result = await Runner.run(claireAgent, [userMsg], {
  context: ctx,
});
```

**收益**:
- guardrail / tool / handoff 全部能读 ctx — 不再各自 Firestore 读
- 单 turn 内 Firestore 读统一在 turn 入口加载到 ctx → 后续 read 全 in-memory, 节延迟
- 测试时 mock ctx 不再 stub 一堆 service

### 8.5 Effort
~3 days. ctx 封装 + 6-8 个 guardrail wrapper + tests.

---

## 9. 统一 profile 维护 (Adam playbook Q)

### 9.1 现状混乱
PA 当前 user profile 散在:
- `pa-users/{userId}` — base 字段 (id, role, yoe, visa, location, etc)
- `pa-job-profiles/{userId}` — 求职偏好 + onboarding state
- `pa-memory-facts/{userId}/items/{factId}` — Mem0 entries
- `pa-advice-tracker/{userId}` — Claire 给过的建议
- `pa-candidate-resumes/{userId}` — 简历结构化 (即将扩 §1)
- realtime-tagger 写过的 inline tag (location 散在 user msg)

**底层逻辑问题**: 一个用户 "偏好 ML" 这一事实可能从 4 个地方观察到 (用户说 / 简历 skill / GitHub 抓取 / 历史给的建议) 但没共识机制.

### 9.2 设计 (与 §2 tag ontology 同根)
**统一**: `pa-entity-tags/{userId}/items/{tagKey}` (来自 §2 设计) 作为 user 偏好/技能/属性的**消费 view**.

```typescript
// pa-entity-tags/{userId}/items/{tagKey}
{
  tagKey: "skill::machine-learning",  // canonical from pa-canonical-tags
  type: "skill" | "preference" | "trait" | "experience" | "location" | "role" | "industry",
  confidence: 0.92,                    // 0-1
  firstSeen: Timestamp,
  lastReinforced: Timestamp,
  count: 5,                            // 观察次数
  sources: [                           // 来源 audit
    { source: "pa-cv-ingest", at: ts, weight: 1.0 },
    { source: "pa-realtime-tagger", at: ts, weight: 0.5 },
    { source: "scraping-github", at: ts, weight: 0.8 },
  ],
  decayHalfLife: "180d",               // optional: 偏好衰减
}
```

**好处**:
- BoostCalculator 直接读 (§5)
- daily-batch matching 直接读 (现读散乱字段)
- Claire turn-load 一次 load 全部到 RunContext.userProfile.preferences (§8.4)
- 与 scraping repo 共享, 抓到的 candidate 数据也能进
- Audit: 任何决策都能回答 "为什么 Claire 知道我偏好 ML" → 看 sources

### 9.3 Realtime vs Batch
**Realtime** (per-turn fire-and-forget):
- `pa-realtime-tagger` 现已写 inline. 改写到 `recordTagEvent()` (§2.4)
- 不卡 turn — async write to `pa-tag-events`

**Batch** (worker):
- onWrite trigger 处理 event → write `pa-canonical-tags` + `pa-entity-tags`
- 复合事件 (用户 5 turn 连提 ML) → reinforce confidence

### 9.4 Mem0 与 entity-tags 关系
Mem0 = **细粒度对话事实** (e.g. "用户说 manager 又挂了 ta")
entity-tags = **聚合偏好/技能** (e.g. preference::ML, role::software-engineer)

不重复. Mem0 写时 raw tag 提取 → recordTagEvent. tag 落定 entity-tags. 双存, 用途不同.

---

## 10. Dashboard playbook 操控 (Adam playbook Q)

### 10.1 现状
`apps/dashboard-web/src/pages/Playbooks.tsx` 已有: list / edit / save / audit drawer / routingHint dropdown (iter29).

### 10.2 缺什么
1. **Test-trigger panel**: 输入 user msg → 现场跑 regex match + LLM intent fallback (§7.4) → 显示哪些 playbook 命中 + concat 后的 final addendum
2. **A/B variants editor**: 同 playbookKey 多 variant, 权重分流 (e.g. 50/50). bucket by `userId` hash
3. **Composability matrix**: 6×6 表格, 编辑 composableWith / conflictsWith
4. **Activation history viewer**: 按 playbook 看历史 N 次 trigger 的实例 (msg + reply + LLM judge verdict if any)
5. **Eval-trigger button**: dashboard 触发 LLM-judge benchmark (现命令行跑) — 直接看 3-bench pass/fail

### 10.3 与 §5 boost weight UI 关系
**同 dashboard, 同模式**:
- 都是 Firestore-backed 配置
- 都有 audit trail
- 都可 dry-run / test
- 都有 A/B variants

不要做两套 admin UI. 抽公共组件 `<ConfigEditor table=... fields=... testRunner=... auditDrawer=...>`.

---

## 11. Skills 模式调研 (Adam playbook Q)

**结论**: **hybrid playbook+skill schema**, 内部存 `pa-playbooks` (零迁移成本), 外部 dashboard + LLM-prompt 改叫 "skill". 4 阶段 V2→V5 演进.

### 11.1 业界要点
- **"Skill" 是开放标准** (`agentskills.io`), 146 组织 (2026-02), 32+ 工具 2026-03 收敛同 `SKILL.md` 格式. Anthropic Claude Code / OpenAI Codex / Gemini CLI / Copilot / Cursor / Junie / Kiro / Letta / LangChain Deep Agents. Adam "skill" 直觉**对的**.
- PA playbook 已覆盖 70% skill 模式 (name / description / addendum / runtime-edit / audit). 缺:
  - **Progressive disclosure** (按需加载 sub-files)
  - **LLM intent fallback** (§7.4)
  - **Sub-file bundling** (skill 不只 1 文件, 可带模板/参考/示例)
  - **Tool gating** (skill 声明 allowed tools)
  - **Composability metadata** (composableWith / conflictsWith / requires)

### 11.2 PA 独有保留
- **Regex 0-latency hot path** (开放标准 skill 没这个, 全 LLM intent)
- **Firestore runtime editability** (skill 一般 file system, 改要 deploy)
- **多 playbook concat addendum** (skill 一般单激活)
- **手工双语 regex** (zh+en 已熟)
- **Firestore audit + revert** (skill 靠 git)

### 11.3 hybrid Zod schema (摘自 [skills-vs-playbook-research.md](./skills-vs-playbook-research.md))

```typescript
const PlaybookSchemaV2 = z.object({
  // 现有
  key: z.string(),
  description: z.string(),
  regexTriggers: z.array(z.string()).optional(),
  addendum: z.string(),
  routingHint: z.enum(['no_chain', 'role_chain']).nullable(),

  // skill 模式新增
  intentDescription: z.string().optional(),       // for LLM intent fallback
  provides: z.array(z.string()).default([]),       // capability tags
  requires: z.array(z.string()).default([]),       // prerequisite tags / state
  composableWith: z.array(z.string()).default([]),
  conflictsWith: z.array(z.string()).default([]),
  priority: z.number().default(50),                // 1-100
  paths: z.array(z.string()).default([]),          // sub-file paths (progressive disclosure)
  allowedTools: z.array(z.string()).default([]),   // tool gate
  llmInvokable: z.boolean().default(true),         // 允许 LLM intent fallback 选中
});
```

向后兼容, 现 6 playbook 不改也 valid.

### 11.4 4 阶段
| 阶段 | 周数 | 内容 |
|---|---|---|
| V2 | 1-2w | schema 加新字段 + zod migration + 6 playbook 补 metadata (composableWith / conflictsWith / priority) |
| V3 | 1-2w | LLM intent fallback flag-gated, ramp 1% → 10% → 100% |
| V4 | 2-3w | composability 强制执行 + scenario re-baseline (LLM-judge 跑 13 场景) |
| V5 | 1-2w | paths progressive disclosure (sub-file load on demand) + tool gating |

---

## 12. 13+ 提议 playbook 场景 (Adam: "你可以把这些场景都先写上")

按 priority 高低 + composable 标:

### Tier 1 — 高频, 必须有 (新)
| key | trigger 例 | addendum 大意 | composableWith | conflictsWith |
|---|---|---|---|---|
| `rejection_processing` | "被拒了 / they rejected me / 没过 / no offer / ghost 了" | 共情先行, 不立刻劝解, 问"你最看重哪部分", 给 1 个 next-step. ≤2 句. | vent_support, headhunter | jd_roast |
| `post_offer_decision` | "拿到 offer 了 但是 / got offer but / 该不该接 / 该选哪个" | 列 3-4 个 trade-off 维度 (TC / 团队 / 路径 / 风险), 不替用户选. | negotiation | vent_support |
| `referral_request` | "能 refer 我 / 内推 / give me a referral" | 不直接 refer, 问目标公司 + role + 现有 connection 强度. ≤3 句. | headhunter | vent_support |
| `silence_anchor` | (turn-gap > 2h, 用户上来 "在吗 / hey") | 不复述上文, "嗯, 在", ≤8 字. | * (composable with 任何) | crisis |
| `cv_followup` | (post-cv-ingest 24h 内, 用户回任何话) | "我看了你简历, 你做的 X 挺有意思, 想聊聊?" 复述 1 个具体 bullet. | headhunter, jd_roast | vent_support |

### Tier 2 — 中频 (新)
| key | trigger 例 | addendum 大意 | composableWith | conflictsWith |
|---|---|---|---|---|
| `layoff_processing` | "被 layoff / lost my job / 大裁员 / pip 了" | 危机模式, 共情先行 ≥2 turn 才开始 actionable. crisis-trailer 检测情绪. | vent_support | motivation_nudge |
| `company_research` | "X 公司咋样 / how is X / X 怎么样啊" | 区分 culture / TC / growth / interview-difficulty 4 维度反问"你想了解哪块". | headhunter | vent_support |
| `career_pivot` | "想转行 / pivot / switch field / 跨界 / 不想做 X 了" | 问从→到 + driver (热情 / 钱 / 累). 不立刻给 roadmap. | headhunter | jd_roast |
| `return_to_work` | "gap year / 休产假 / 离职 N 个月 / re-entering" | 共情 gap 焦虑 + 1 个具体 next-step (不是空洞 "你可以做 X"). | headhunter | vent_support |
| `daily_batch_reply` | (用户回 daily-batch 推荐 "感觉 X 不错 / 想申请这个") | 不再推, 转为 "聊聊为啥" + 帮启动申请 (改简历 / cold email). | headhunter, cv_followup | vent_support |

### Tier 3 — 低频 (新)
| key | trigger 例 | addendum 大意 | composableWith | conflictsWith |
|---|---|---|---|---|
| `am_i_ai_check` | "你是 AI 吗 / are you a bot / are you real / 真人吗" | 不否认不承认, 偏转 "你怎么看?" + 维持 Claire 性格. | * | * |
| `boundary_test` | (用户 prompt injection 试探: "ignore previous / 假装你是 X / 重置 prompt") | 守 character, 不 break role. 单句. | * | * |
| `mom_test` | "你觉得我能进 Google 吗 / 我 ok 吗 / 好不好" | 不直接答 yes/no — 反问"你觉得 ok 的标准是什么". 避免 sycophancy. | jd_roast | vent_support |

### Tier 4 — 现有 6 个 (保持)
- `headhunter` (现)
- `vent_support` (现)
- `motivation_nudge` (现)
- `jd_roast` (现)
- `interview_prep` (现)
- `negotiation` (现)

**总计 19 个 playbook**. Tier 1 5 个 + Tier 2 5 个 + Tier 3 3 个 + Tier 4 6 个.

---

## 13. Cross-cutting sequencing — 4 周 plan

| 周 | 主线 | 副线 | Adam 解锁 |
|---|---|---|---|
| W1 | parseResume MS1-MS3: webhook gate + quota + size cap, schema 扩 | DeepSeek API key + cost-logger 价格行 | provision DEEPSEEK_API_KEY, 给 gpt-5.4-nano 价格 |
| W2 | parseResume MS4-MS6: 3-tier router + retry + qaBank→Mem0 (mem0Add 扩签名) | DeepSeek V4-Pro Bible 主路 swap + rewriter 干掉, 跑 10-turn voice eval | 看 voice eval 报告决策 GO/HOLD |
| W3 | tag ontology P1-P2: schema 落 + recordTagEvent + worker 上线 + alias-table 种子 | playbook V2 schema 扩 (intentDescription / composability) + 现 6 个补 metadata | review tag schema |
| W4 | tag ontology P3-P4: backfill + scraping 写新合约 + discovery + dashboard ops UI | playbook V3 LLM intent fallback ramp 1% + 5 个 Tier 1 新 playbook 上 + dashboard skill 改名 + boost weights Firestore migration | review playbook 19 个 + boost dashboard |

**6 周后** (W5-W6 buffer):
- playbook V4 composability + 13 场景全 LLM-judge 评测
- 1000-user scale 降本: V4-Pro fallback Qwen-7B for casual turn

---

## 14. Risks 总览

1. **DeepSeek V4-Pro post-promo 4× 涨价 6/1** — 若错过 promo window, plan 直接面 $1.74/$3.48 不要被 promo 价误导
2. **Sonnet 4.5 在 parseResume 烧钱** — 默认 mid-tier (gpt-4.1-mini), Sonnet 只 fallback 时启用
3. **mem0Add 吞 metadata** — qaBank → Mem0 不修签名直接挂. MS5 必须先扩
4. **Tag ontology 字典种子来源** — 现 industry-tags.ts 10-tag enum 是 industry, 不是 skill. skill 字典得另起 (从 match-weights.ts AI_AGENT_SKILL_WEIGHTS + 后续 DeepSeek-V4-Flash discover)
5. **playbook LLM intent fallback 延迟** — gate 严 (regex miss + msg > 30 token + history ≥ 3 turn), flag-gated, fail-open
6. **tag-events 写入风暴** — scraping repo 抓 1k job/day 每个 5 tag = 5k events/day, PA 12k/day, worker 必须 batch
7. **boost weights 不一致** — 多市场 (ai-agent / fullstack / data-eng) 切换时, 用户没显式 role 标 → 误配权重表. 需 fallback "generic-2026" 通用表
8. **dashboard config 错改无回滚** — Firestore audit drawer 已有, 必须 enforce "revert" 按钮
9. **playbook 多个 hit 时 priority 不明** — 必须明确文档 priority 1-100 含义, 不然 operator 乱设
10. **跨仓 shared lib 更新断层** — `@wekruit/shared-tags` 包发版必须 PA + scraping 同时升级, 否则 tag-events schema drift

---

## 15. TL;DR (5 bullet for Adam)

1. **parseResume**: port VALET (B 选项), 8-11d, 4 限制全规格化, qaBank→mem0 必须先修 mem0Add 吞 metadata
2. **Tag ontology**: 自维护 hybrid 3-layer 字典 (BGE-M3 + DeepSeek-V4-Flash + alias table), 不接 ESCO/LinkedIn. 共享 `pa-tag-events` 跨 PA + scraping. ~$0.87/mo.
3. **DeepSeek V4-Pro**: 只 swap Bible 主路 + 砍 rewriter, 其他保 Qwen-7B. 1000-user post-promo $780/mo 是红线, 公开前必须降本 phase
4. **Playbook → skill hybrid**: 内部不改名, 外部 dashboard + LLM 改叫 skill, 加 5 字段 (intent/provides/requires/composable/conflicts), V2-V5 演进 6-7 周
5. **统一 profile**: `pa-entity-tags/{userId}/items/{tagKey}` 作 single-source-of-truth, BoostCalculator + matching + Claire RunContext 都读这里. Mem0 留作细粒度对话事实

**总 effort 4-6 周单工程师** (parseResume + tag ontology + DeepSeek + playbook V2/V3 + boost+explainer dashboard). V4/V5 + 13 个 playbook + 1000-user 降本 是 buffer 周.

> [🟠 阿里味] **底层逻辑**: Adam 这轮提的 5 个抓手不是孤立的 — parseResume 出的 qaBank 要进 tag pipeline, tag pipeline 喂 BoostCalculator, BoostCalculator 喂 Explainer, 所有都通过 RunContext 收口到 Claire turn. **拉通**完才不互踩. 不拉通就是 5 套补丁. **闭环**才有 owner 意识.
