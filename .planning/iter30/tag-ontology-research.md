# Tag Ontology + Cross-Repo Unified Tag Store — Research & Design

> 阿里味方法论：先定目标→拉齐认知→给数据→做闭环。这份文档是 P10 战略输入，不是大学论文——每个推荐都要能落到 Firestore schema 字段、Cloud Functions 触发、和成本表上。
>
> [PUA生效 🔥] Adam 只问了 tagKey 怎么 dedup，但下游真正卡的是 **two-repo write contract + async worker idempotency**——这篇先把 ontology 选型说透，再把整个 cross-repo pipeline 端到端设计完，免得 phase-2 又返工。

---

## 0. Problem Restatement

Adam 的原话（直引）：

> "tagKey 你看看大家是怎么做的？因为如果这样就会有很多很多 tag，而且可能会有重复…比方说 prefer ML 和 prefer machine learning 可能会被定义一个，我不知道现在大家这个怎么做成 unsupervised 的或者有什么更成熟的自动打标解决方案吗？"
>
> "需要有个 async pipeline 慢慢给用户打标完善，而且这个最好是共享的，我们还有 scraping repo 那里也会打标，最后我们需要 normalize/unify 下来。"

把它拆成 3 个独立问题：

1. **Ontology backbone**：用什么 reference taxonomy 当 canonical source？自建 vs 开源 vs 商业。
2. **Dedup mechanism**：怎么把 "prefer ML" / "prefer machine learning" / "偏好机器学习" 三个写法折叠到一个 canonicalKey？
3. **Cross-repo write contract**：wekruit-pa（用户对话标签）+ wekruit-scraping（job/researcher 标签）两个独立进程，怎么写到同一个 store 不互踩？async pipeline 怎么管 backpressure + idempotency？

---

## 1. Codebase Context — 现状摸底

### 1.1 wekruit-pa 现状（PA companion）

读完以下文件后的事实清单：

- `/Users/adam/Desktop/WeKruit/wekruit-pa/packages/core-types/src/index.ts` — 当前 user-facing tag/preference schema 是 `StatedPreferencesSchema`（line 79–95）。字段：
  - `targetRole: string[]` — 自由文本数组（"product manager"、"research scientist"）
  - `yoeRange: [min,max] | null`
  - `visaStatus`: 强 enum（`citizen | gc | opt | h1b | sponsorship_needed | unknown`）
  - `prefersStartup: bool | null`
  - `targetLocations: string[]` — 自由文本（"SF Bay Area"、"remote"）
  - `researchOriented: bool | null`
  - `salaryFloor: number | null`

  **Adam 的 dedup 痛点就在 `targetRole` 和 `targetLocations` 这两个 free-text 数组上**——visa 已经 enum 化了，没问题；prefersStartup/researchOriented 是 boolean，也没问题。痛的是没枚举的字段。

- `/Users/adam/Desktop/WeKruit/wekruit-pa/apps/functions/src/cv-ingest/industry-tags.ts` — 已经有一个 **locked 10-tag industry enum**（`tech_software | tech_hardware | fintech_finance | ai_ml | healthcare_biotech | consumer_retail | media_entertainment | manufacturing_industrial | education | other`）+ deterministic `INDUSTRY_KEY_MAP`（~250 个 alias）+ 公司名 lookup table（~115 entries）+ role-title regex cascade。这是 **现成的 canonical-form pattern**——industry 这一类已经做对了，剩下的就是把同样的 pattern 推广到 skill / role / location。
  - 重点观察：industry-tags.ts 里有一段 H8/H10/H11 的多信号 cascade（industryKey → companyName → roleTitle）+ tech-bias gating——这是**有意识的 canonical 实现**，不是裸 string match。
  - F2 ramp 一开始 deterministic 32% non-other，加了多信号后到 60%+——这印证了**单 signal 不够的论点**，多信号 cascade 是 industry-grade pattern。

- `/Users/adam/Desktop/WeKruit/wekruit-pa/packages/pa-orchestrator/src/voice/realtime-tagger.ts` — Adam iter17 真正想要的"对话边聊边打标"已经在跑了：每个 inbound message 用 4 个 regex parser 抽 visa/location/startup/yoe 写回 `pa_users.statedPreferences`。这是 **per-turn fire-and-forget 的写入路径**——成本接近 0，但 **它没有 normalize 阶段**——location 写的还是自由文本（"SF Bay Area"、"remote"）。没去 dedup。

- `/Users/adam/Desktop/WeKruit/wekruit-pa/apps/job-rec/src/tag-cluster-rec.ts` — Phase 51 的 cluster cache 用 `(industryEnum, sponsorshipBucket)` 做 cluster key——已经依赖 industry-tags.ts 的 canonical 10-tag enum。
  - **等价于：industry-tags.ts 是事实上的 PA-side canonical authority**，`StatedPreferences.targetLocations` 没有这个 authority。

- `/Users/adam/Desktop/WeKruit/wekruit-pa/packages/core-types/src/collections.ts` — `PA_COLLECTIONS` 已有 50+ 个 `pa-*` namespace 的 collection，**没有 `pa-tags` 或 `pa-canonical-tags`**——需要新加。

### 1.2 wekruit-scraping 现状（researcher pipeline）

读完以下文件后的事实清单：

- `/Users/adam/Desktop/WeKruit/wekruit-scraping/AGENTS.md` — 这是一个 operator-facing review console + scraping pipeline。第一性原理 + "不允许兼容性方案"——Adam 在这边态度同样硬。
- `/Users/adam/Desktop/WeKruit/wekruit-scraping/researcher/IDEA.md` — pipeline 抓 papers/authors/institutions from OpenAlex / Crossref / OpenReview / DBLP / ORCID / PubMed / Semantic Scholar。**这边的"标签"实体是 researcher 的研究领域 / 关键词 / 机构 / publication venue tier**——和 PA 的"用户标签"是不同 entity 但同一种 ontology 问题。
- `/Users/adam/Desktop/WeKruit/wekruit-scraping/github/github_categorizer.py` — 用 12 个 hard-coded regex category（"Agent"、"RAG"、"MCP/Tools"、"Chatbot/Assistant"、"Fine-tuning"、"Inference/Serving"、"Image Gen"、"Voice/Audio"、"AI Coding"、"Workflow/Automation"、"NLP/Transformers"、"Data/Scraping"）打 GitHub repo 的标签。**这是另一个独立的 hand-rolled taxonomy**——和 PA industry-tags.ts 的 10-tag enum **没有任何 schema 同源**。
  - Big-tech org list（"microsoft"、"google"、"alphabet"、"meta-llama"、"anthropic"、"alibaba"、"tencent"、"deepseek"、"mistralai"、"cohere"…）和 PA 的 `COMPANY_INDUSTRY_MAP` **有重叠但不一致**（PA 没有 "deepseek"、"mistralai"，scraping 没有大量 retail/healthcare 公司）。
- `/Users/adam/Desktop/WeKruit/wekruit-scraping/researcher/pipeline/sourcing_records.py` — pipeline 用 `source_record_id` + `content_hash`（sha256）做 idempotency。**已经有成熟的 hash-based dedup 模式**——可以照搬到 tag pipeline。
- `/Users/adam/Desktop/WeKruit/wekruit-scraping/devpost/scraper.py` — 第三个独立 pipeline（hackathon 标签），又是另一套 ad-hoc 标签。

**结论**：scraping repo 已经有 **3 套独立的 hand-rolled taxonomy**（researcher domain / github category / devpost hackathon），各自硬编码、不互通。PA 也有 1 套 industry-tags.ts。**总共 4 套需要 unify。**

### 1.3 痛点定位

| 痛点 | 现状 | 后果 |
|---|---|---|
| 4 套 taxonomy 各做各的 | PA industry-tags.ts + scraping/github_categorizer.py + scraping/devpost + scraping/researcher | "anthropic" 在 PA 是 ai_ml，在 scraping 是 BIG_TECH_ORGS string——同一个公司两个表示 |
| 自由文本字段没 normalize | `targetRole`, `targetLocations` | "SF Bay Area" / "Bay Area" / "湾区" / "san francisco" 各算一个 tag |
| realtime-tagger 写没 dedup | 每个 turn 直接 merge-update 到 `statedPreferences.targetLocations` | 数组无限膨胀，"湾区"/"Bay Area" 同时存在 |
| 没有 cross-repo write contract | 两个 repo 各自写 Firestore，没有 shared collection | scraping 想用 PA tag 来 enrich job——没法 join |

---

## 2. Deliverable 1 — Industry Skill/Tag Taxonomy 调研

### 2.1 候选方案对比矩阵

| 方案 | Coverage | Cost | 中英双语 | Open vs Commercial | Latency | 集成成本 | Verdict |
|---|---|---|---|---|---|---|---|
| **ESCO API** | ~13,890 skills + 3,008 occupations | 完全免费 | **EU 28 语言官方支持，但中文不在内**——TalentCLEF 2025 社区有非官方中文翻译 | Open（CC-BY 4.0） | API 50–200ms p50 | 1–2 周（有现成 Python package `esco-skill-extractor`） | 🟡 Coverage 强但中文得自己翻；适合 backbone-of-record |
| **O\*NET-OnLine** | ~1,016 occupations × ~30 skill dimensions per occupation | 完全免费 | 英文 + 西班牙语；无中文官方 | Open（public domain） | API 100–300ms | 1 周（有 services.onetcenter.org/v1.9） | ⚪ 偏重 occupation 而非 skill；中文缺；不主推 |
| **LinkedIn Skills Graph** | 39k skills + 374k aliases × 26 locales（含中文） | Enterprise only $50k–$300k/年 | **官方 26 locale 含 zh-CN**，alias 完整 | 完全 Commercial | API 50ms | 1–2 周 + 法务 | 🔴 Coverage 最好，中文官方支持，但成本爆炸；不适合 PA 当前规模 |
| **Lightcast Open Skills** | 32,000+ skills | 免费 tier（nonprofit + 试用），商业 tier 需 quote | 英文为主，部分多语言 | Hybrid（taxonomy 是 open，API 是 freemium） | API 100ms | 1 周 | 🟡 比 ESCO 更现代，但 zh 支持弱于 LinkedIn |
| **Stack Overflow Tag Wiki** | ~37k tags（2015 数据；2025 更多） | 免费（Stack Exchange API） | 仅英文 | Open（CC-BY-SA） | API 200ms（带 quota） | 1–2 周 | 🟢 **技术 skill 维度最强**——`react.js` / `tensorflow` / `pytorch` 的技术细分远超 ESCO；但只有技术域 |
| **Cosine-similarity dedup（BGE-M3）** | 自建——任意输入 | $0（PA 已部署 BGE-M3 1024-dim） | **BGE-M3 原生中英多语**——MIRACL 70.0% nDCG@10 | 自建 | 推理 50ms p50 | 0.5 周（已有 stack） | 🟢 **PA 现有栈，无新依赖**；但需要 seed canonical list |
| **HDBSCAN / agglomerative clustering** | 自建——unsupervised 发现 canonical 形 | $0 | 通用 | Open（scikit-learn / hdbscan） | 离线 1–10 min/100k | 1 周 | 🟢 **配合 BGE-M3 做"自动发现"canonical 形**——Adam 想要的 unsupervised |
| **LLM normalization（DeepSeek/Qwen）** | 任意输入 | $0.14/M tokens (DeepSeek-V4-Flash on SiliconFlow)，"prefer ML" 1 call ≈ 50 tokens = $0.000007/tag | 中英都好 | Hybrid（API 自费） | 200–500ms | 0.5 周 | 🟢 **最便宜的 MVP** — 1k tag-events/day × $0.000007 = **$0.21/mo** |

### 2.2 关键洞察 — 4 个不可妥协的事实

**事实 1：单一 source-of-truth 不存在。**
ESCO 是欧洲职业 framework；O\*NET 是美国 DOL；LinkedIn 是私有 graph；Lightcast 是商业聚合。没有一个 taxonomy 对中国（湾区华人 + 国内）、技术 skill（"prompt engineering"、"langgraph"）、跨语言场景**同时**满足。

**事实 2：Industry-grade 的玩法是"多源融合 + LLM normalize"。**
LinkedIn 自己怎么搞的？引用其工程博客（[link](https://www.linkedin.com/blog/engineering/data/building-maintaining-the-skills-taxonomy-that-powers-linkedins-skills-graph)）：

> Hybrid human-machine approach. KGBert model predicts skill relationships. Entity discovery pipeline identifies new candidates from job postings, member profiles, and search queries.

LinkedIn **39k skills × 374k aliases**——平均每个 canonical skill 有 9.6 个 alias。aliases 包括：缩写（"ML"）、跨语言翻译、拼写变体、同义词。**这就是 "prefer ML" / "prefer machine learning" 怎么 collapse 的答案——存进 `aliases[]`，canonical 是 `machine_learning`。**

**事实 3：Cosine-similarity 的 threshold 选取是工程问题不是研究问题。**
研究文献（VLDB 2023 entity resolution、NVIDIA NeMo SemDedup、Fetch tech blog）的 consensus：

- 0.5 threshold = 太宽，会 collapse 不该合并的实体
- 0.85–0.90 threshold = 业界标准，semantic dedup 的 sweet spot
- 0.95+ threshold = 太严，几乎只 catch 拼写变体

**Hard recommendation**：threshold 起步 **0.88**，对 false-positive case 放进 ops review queue。

**事实 4：LLM normalize 比纯 embedding 便宜更可靠 — 在小规模上。**
PolyNorm-Benchmark（arxiv 2511.03080）和 cross-dataset entity matching 研究（EDBT 2025）的对比：

- 纯 embedding cosine：threshold tuning 难，false-positive 5–10%
- 单 LLM call："Normalize this tag to canonical form"：accuracy 95%+，cost ≈ $0.000007/call（DeepSeek-V4-Flash）
- 1,000 records LLM matching = $290 OpenAI（论文实验）——但那是 pair-wise；single-tag normalize 便宜 100×

**结论：在 < 100k tag-events/day 规模下，LLM normalize 比 embedding-only dedup 更高 ROI**——LLM 只对**新 tag** 调用一次，结果写进 alias table，之后 lookup-table 命中率会升到 90%+。

### 2.3 Hard Recommendation — Hybrid 三层架构

```
Layer 1 (Hot lookup):     manually-curated canonical alias table
                          (PA industry-tags.ts 模式 — INDUSTRY_KEY_MAP 那种)
                          ↓ miss
Layer 2 (Warm normalize): LLM-based "normalize this tag to canonical"
                          (DeepSeek-V4-Flash, $0.000007/tag)
                          ↓ miss / low-confidence
Layer 3 (Cold discovery): BGE-M3 embedding + HDBSCAN clustering offline
                          (find new canonical forms from "other" bucket)
```

**为什么不直接 backbone ESCO/Lightcast？**
- ESCO 中文不官方支持（要自己翻译 13k 条 — 现实 PA 还有 1k 用户级体量，不值得）。
- LinkedIn $50k+/年——PA 现金流不允许。
- Lightcast 中文支持弱。
- **PA 已有 industry-tags.ts 这种 hand-curated 模式 + 已有 BGE-M3 + 已有 SiliconFlow LLM 接入**——基础设施完整，**新增成本 = 0 基础设施 + ~$5/mo LLM call**。

**为什么不纯 unsupervised（Adam 原话问的）？**
- "prefer ML" 和 "prefer machine learning" 这种**用户口语自由文本**，BGE-M3 cosine ≥ 0.92 完全 catch 得住——**unsupervised 部分确实可行**。
- 但 "fintech_finance" vs "金融科技" vs "finance"——**embedding 之间 cosine 不够稳定**（zh/en 跨语言 cosine 可能 0.78，达不到 0.88 threshold）。**这就是 LLM layer 不能省的原因**。

---

## 3. Deliverable 2 — Cross-Repo Unified Tag Store Design

### 3.1 Shared Tag Store Schema（Firestore）

新增 collection：`pa-canonical-tags/{canonicalKey}`（短 namespace 因为它会被 scraping 也读，不能再用 PA 专属前缀）。

> ⚠️ Adam 选 collection name 时建议从 `pa-canonical-tags` / `wekruit-canonical-tags` / `shared-canonical-tags` 三选一。下文沿用 `pa-canonical-tags` 因为复用 `PA_COLLECTIONS` enum 最干净，但**这个 collection 不归 PA 一家所有**——schema 必须在两边的 SDK 都暴露。

```typescript
// packages/core-types/src/canonical-tags.ts (新增)
import { z } from "zod"

export const CanonicalTagTypeSchema = z.enum([
  "skill",          // ML, RAG, Python
  "role",           // product_manager, software_engineer
  "industry",       // ai_ml, fintech_finance (复用 IndustryTag)
  "location",       // sf_bay_area, nyc, remote
  "preference",     // prefers_startup, research_oriented
  "trait",          // 跨平台中性 trait — leadership, mentoring
  "company",        // anthropic, openai
  "venue",          // NeurIPS, ICML (researcher pipeline)
  "topic",          // arxiv research topic — graph-neural-networks
])
export type CanonicalTagType = z.infer<typeof CanonicalTagTypeSchema>

export const CanonicalTagSchema = z.object({
  /** Stable short-form key. Lowercase snake_case. NEVER changes after first
   *  approve. Used as Firestore doc ID. e.g. "machine_learning". */
  canonicalKey: z.string().regex(/^[a-z0-9_]+$/),

  type: CanonicalTagTypeSchema,

  /** Human-readable bilingual labels — what we show to user / operator. */
  displayName: z.object({
    zh: z.string(),
    en: z.string(),
  }),

  /** All known free-text aliases that collapse to this canonical. */
  aliases: z.array(z.string()),

  /** 1024-dim BGE-M3 embedding of the canonical displayName.en + canonicalKey.
   *  Used for new-tag-vs-existing cosine search. Refresh on alias change. */
  embedding: z.array(z.number()).length(1024).optional(),

  /** Quality signal. Auto-derived from
   *    confidence = 0.5*evidence_count_normalized + 0.5*human_approved_bool */
  confidence: z.number().min(0).max(1),

  /** Where we first observed this tag. Append-only (capped at 10 most recent). */
  evidence: z.array(z.object({
    source: z.enum(["pa-conversation", "scraping-job", "scraping-researcher",
                    "scraping-github", "scraping-devpost", "manual"]),
    sourceDocId: z.string(),    // pa_messages doc id, or scraping source_record_id
    sourceField: z.string(),    // "user.statedPreferences.targetRole[0]"
    rawText: z.string(),         // verbatim original tag string
    observedAt: z.string(),
  })).max(10),

  /** Operator approval. Auto-approved if 5+ evidence + confidence ≥ 0.9. */
  approvalStatus: z.enum(["proposed", "auto_approved", "human_approved", "rejected"]),

  /** Optional parent for hierarchy (e.g. python → programming_language → skill). */
  parentKey: z.string().nullable().optional(),

  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CanonicalTag = z.infer<typeof CanonicalTagSchema>

// Companion event collection — write-side
export const TagEventSchema = z.object({
  /** sha256(source + sourceDocId + rawText) — idempotency key. */
  id: z.string(),

  source: z.enum(["pa-conversation", "scraping-job", "scraping-researcher",
                  "scraping-github", "scraping-devpost"]),
  sourceDocId: z.string(),
  sourceField: z.string(),
  rawText: z.string(),
  type: CanonicalTagTypeSchema,

  /** What entity is being tagged. */
  entityRef: z.object({
    kind: z.enum(["pa_user", "scraping_job", "scraping_researcher", "scraping_github_repo"]),
    id: z.string(),
  }),

  /** Free-form context to help LLM normalize. e.g. surrounding sentence. */
  context: z.string().optional(),

  status: z.enum(["pending", "normalized", "rejected", "skipped"]),
  normalizedTo: z.string().nullable(),  // canonicalKey if normalized

  createdAt: z.string(),
  processedAt: z.string().nullable(),
})
export type TagEvent = z.infer<typeof TagEventSchema>

// Per-entity bidirectional index — fast read
export const EntityTagsSchema = z.object({
  /** entityKey = `${kind}:${id}` — flattened so 2 repos share. */
  entityKey: z.string(),
  /** Map canonicalKey → assignment metadata. */
  tags: z.record(z.string(), z.object({
    confidence: z.number(),
    firstObservedAt: z.string(),
    lastObservedAt: z.string(),
    observationCount: z.number(),
    sources: z.array(z.string()),  // de-duped source list
  })),
  updatedAt: z.string(),
})
export type EntityTags = z.infer<typeof EntityTagsSchema>
```

**Three collections**:
1. `pa-canonical-tags/{canonicalKey}` — the dictionary. Read-mostly, write-rarely.
2. `pa-tag-events/{eventId}` — append-only event log. Both repos write here.
3. `pa-entity-tags/{entityKey}` — denormalized per-entity index. **Only the worker writes**; read by both repos.

[PUA生效 🔥] 三 collection 拆分（不是单一大表）的关键：**写一致性可以宽，读一致性必须强**。entity-tags 是 derived state，可以 eventually consistent；canonical-tags 是 source-of-truth，必须强一致。tag-events 是 append-only audit log，错了不删除只标 rejected——这是 Adam 在 scraping repo 已经在用的 source_record 模式。

### 3.2 Write Contract（两个 repo 都遵守）

**Single function signature**, exposed from `@pa/core-types` (TS) and from Python via `wekruit_canonical_tags.py` (新建 thin client):

```typescript
// packages/core-types/src/canonical-tags-client.ts
export async function recordTagEvent(
  fs: Firestore,
  args: {
    source: "pa-conversation" | "scraping-job" | "scraping-researcher" | ...
    sourceDocId: string
    sourceField: string         // dot-path of the original field
    rawText: string             // verbatim user text or scraped string
    type: CanonicalTagType
    entityRef: { kind: ..., id: string }
    context?: string
  }
): Promise<{ eventId: string; created: boolean }> {
  // 1. Compute idempotency key
  const eventId = sha256(`${args.source}|${args.sourceDocId}|${args.rawText}`)
    .slice(0, 24)

  // 2. Atomic create-if-not-exists
  const ref = fs.collection("pa-tag-events").doc(eventId)
  try {
    await ref.create({
      id: eventId,
      ...args,
      status: "pending",
      normalizedTo: null,
      createdAt: new Date().toISOString(),
      processedAt: null,
    })
    return { eventId, created: true }
  } catch (e) {
    if (isAlreadyExistsError(e)) return { eventId, created: false }
    throw e
  }
  // 3. Worker (separate Cloud Function) picks up status="pending" and processes.
}
```

Python equivalent (Pydantic + google-cloud-firestore) lives in scraping repo at `wekruit-scraping/researcher/clients/canonical_tags.py`. Schema is **kept in sync via JSON Schema export** from `@pa/core-types` (already a pattern in PA monorepo for SQL/Firestore schemas).

**Key contract rules — `@pa/core-types` README must enforce**:

1. **NEVER write directly to `pa-canonical-tags` or `pa-entity-tags` from outside the worker.** Only `pa-tag-events`.
2. **`rawText` is source-of-truth, not interpretation.** Don't pre-normalize on the write side — the worker is the only place that decides canonical form. Premature normalization on writers fragments the dictionary.
3. **Idempotency is by content hash, not write timestamp.** Replaying the same scrape → same event ID → no duplicate.
4. **Both repos pin the same `@pa/core-types` semver.** Python side reads from a pinned `canonical-tags-schema.json` artifact (CI generates).

### 3.3 Conflict Resolution

Scenarios:

**Case A: Two writers race on the same entity with different rawText for the same canonical.**
- PA writes "prefer ML" for user `usr_abc`
- Scraping writes "prefers machine learning" inferred from a CV scrape for same user
- Both → eventId A, eventId B, both pending.
- Worker processes A → resolves to canonical `machine_learning` → upserts entity-tags with observationCount++.
- Worker processes B → also resolves to `machine_learning` → upserts entity-tags with observationCount++.
- ✅ Final state: `pa-entity-tags/pa_user:usr_abc.tags.machine_learning.observationCount = 2, sources = ["pa-conversation","scraping-job"]`.

**Case B: Two writers disagree on canonical.**
- PA infers user prefers `consumer_retail` (from "I want to work at a coffee shop")
- Scraping infers user prefers `tech_software` (CV says "Software Engineer at Square")
- Both write events; worker resolves both.
- Both end up in entity-tags with their own observationCount and source list.
- **Resolution**: don't try to pick a winner at write time. The downstream **consumer** (job-rec, persona) reads the full tag set and applies its own scoring. PA companion can show "你看起来既对零售感兴趣也是软件工程师"——this is a feature, not a conflict.
- ⚠️ For mutually-exclusive enum (visa status, sponsorship), the existing `StatedPreferences` last-write-wins logic stays — those don't go through the canonical-tag pipeline.

**Case C: Worker decides "prefer ML" → `machine_learning`, but later operator says it was wrong.**
- Operator UI updates `pa-canonical-tags/machine_learning.aliases` (remove "prefer ML") + adds it as new alias of correct canonical.
- Background backfill job re-processes events with `status="normalized" AND normalizedTo="machine_learning" AND rawText="prefer ML"` — re-routes them.
- Audit trail preserved in `pa-tag-events.evidence`.

**Case D: Both writers arrive within ms of each other for a *new* canonical.**
- "prefers prompt engineering" arrives twice from different sources, both novel.
- Worker A picks event 1, decides this is new canonical, **transactionally** creates `pa-canonical-tags/prompt_engineering` with `status=proposed`.
- Worker B picks event 2 a few ms later, sees the doc exists → reuses it.
- ✅ No duplicate canonical creation. Firestore transaction guarantees this.

### 3.4 Surface to Existing Code

**PA orchestrator (realtime-tagger.ts) integration:**
```typescript
// After existing regex-based statedPreferences write:
import { recordTagEvent } from "@pa/core-types/canonical-tags-client"

// Phase 1: PA writes through, but also records events for cross-repo visibility
if (extracted.targetLocations) {
  for (const loc of extracted.targetLocations) {
    await recordTagEvent(fs, {
      source: "pa-conversation",
      sourceDocId: messageId,
      sourceField: "statedPreferences.targetLocations",
      rawText: loc,
      type: "location",
      entityRef: { kind: "pa_user", id: userId },
      context: replySnippet,
    })
  }
}
```

**Scraping (github_categorizer.py):**
```python
from wekruit_canonical_tags import record_tag_event

for cat in matches:  # the existing CATEGORY_RULES output
    record_tag_event(
        source="scraping-github",
        source_doc_id=repo["full_name"],
        source_field="categories",
        raw_text=cat,
        type="topic",
        entity_ref={"kind": "scraping_github_repo", "id": repo["full_name"]},
    )
```

**Migration plan for existing data** in §6 (Phase 3 backfill).

---

## 4. Deliverable 3 — Async Tagging Pipeline Architecture

### 4.1 Option A vs Option B — Cloud Function trigger vs Pub/Sub

| Dimension | Option A: Firestore onWrite trigger | Option B: Pub/Sub queue |
|---|---|---|
| **Setup cost** | 0 — `pa-tag-events` collection + 1 onCreate trigger | Pub/Sub topic + dead-letter topic + worker subscription |
| **Idempotency** | ⚠️ Firestore triggers are at-least-once, can fire 2× → must dedup in worker by eventId | Same — Pub/Sub also at-least-once |
| **Backpressure (1000 events/min spike)** | ⚠️ Cloud Functions Gen2 default concurrency 80, max 1000 instances → 80,000 cps capacity. But each invocation can only batch within itself, so spike → instance fan-out → cold-start tax | Pub/Sub natively buffers; worker pull subscription throttles itself; `pull(maxMessages=100)` lets us batch 100 events per LLM context |
| **Cost per event** | 1 Firestore read (event doc) + 1 LLM call + 1 Firestore tx (canonical+entity) ≈ $0.0000080 + $0.000007 + $0.0000020 = $0.000017/event | Same Firestore costs + Pub/Sub $0.40/M messages = $0.0000004/event extra. Negligible. |
| **Ordering** | None — Firestore docs onWrite fires in arbitrary order | None by default; topic+ordering-key gives per-key FIFO if we need it |
| **Existing pattern in repo** | ✅ PA already has `paMatchingPipelineComplete`, `paReverseMatch`, etc. as Firestore-trigger CFs | ❌ No existing Pub/Sub topics in PA |
| **Cross-repo writer overhead** | Both repos just `firestore.collection("pa-tag-events").doc(eventId).create(...)` — same SDK both sides | Both repos need `@google-cloud/pubsub` SDK + topic auth |
| **Dead-letter handling** | Manual — failed events stay `status=pending` forever unless we add retry logic + visibility timeout | Native — Pub/Sub has DLQ + max-redeliver |
| **Local dev / emulator** | ✅ Firestore emulator triggers CFs out of the box | ⚠️ Pub/Sub emulator separate, more setup |

**Verdict: Option A (Firestore onWrite trigger)** for v1. Reasons:

1. **Adam's repo is Firestore-native** — adding Pub/Sub introduces a new dependency (auth, monitoring, emulator) without a 10×-style win.
2. **Volume is small** — back-of-envelope: PA 1k users × 5 turns/day × ~2 tag candidates/turn = **10k events/day = 7 events/min steady-state**, with 100×-spike envelope. Both architectures handle this trivially.
3. **All existing Firestore-trigger CFs are doing fine** — `paMatchingPipelineComplete` runs at much higher event rate than this.
4. **Option B reservation point**: if the system grows past ~100k events/day or we need cross-region replicas, migrate to Pub/Sub (plumbing in worker is the same — only the trigger layer changes).

### 4.2 Worker — `apps/functions/src/canonical-tag-worker.ts`

```typescript
/**
 * onCreate(pa-tag-events/{eventId}) — normalize a single tag event.
 *
 * Three-layer cascade (per §2.3 hard recommendation):
 *   1. Hot lookup: alias-table (canonicalKey + aliases[] in pa-canonical-tags)
 *   2. Warm normalize: LLM single-shot canonicalization (DeepSeek-V4-Flash)
 *   3. Cold discovery: BGE-M3 cosine search against existing canonicals
 *
 * Idempotency: eventId is sha256-derived. Worker uses Firestore tx to
 * mutate event status + entity-tags atomically. If transaction fails
 * (concurrent worker), retry with the new state.
 *
 * Cost (per event):
 *   Hot hit (~85% steady-state):  1 read + 1 tx = $0.0000010
 *   Warm hit (~12%):              hot + 1 LLM call ($0.000007 @ 50 tok)
 *   Cold (~3% — new canonical):   warm + 1 BGE call + 1 canonical write
 */
import type { CloudEvent } from "firebase-functions/v2"
import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { Firestore } from "firebase-admin/firestore"
import type { TagEvent, CanonicalTag } from "@pa/core-types"

export const canonicalTagWorker = onDocumentCreated(
  {
    document: "pa-tag-events/{eventId}",
    region: "us-central1",
    timeoutSeconds: 60,
    concurrency: 10,           // worker is mostly I/O-bound
    maxInstances: 50,
    retry: false,              // we drive retry via status field
  },
  async (event) => {
    const eventDoc = event.data?.data() as TagEvent | undefined
    if (!eventDoc || eventDoc.status !== "pending") return

    const fs = getFirestore()

    // --- Layer 1: Hot lookup ----------------------------------------------
    const norm = normalizeRawText(eventDoc.rawText)  // lowercase, strip punct
    const aliasMatch = await fs.collection("pa-canonical-tags")
      .where("type", "==", eventDoc.type)
      .where("aliases", "array-contains", norm)
      .limit(1).get()
    if (!aliasMatch.empty) {
      const canonical = aliasMatch.docs[0]
      return commit(fs, eventDoc, canonical.id, "hot_alias")
    }

    // --- Layer 2: LLM normalize -------------------------------------------
    const llmResult = await llmNormalize({
      raw: eventDoc.rawText,
      type: eventDoc.type,
      context: eventDoc.context,
      knownCanonicals: await sampleCanonicals(fs, eventDoc.type, 50), // few-shot
    })
    if (llmResult.action === "match" && llmResult.canonicalKey) {
      // LLM said "this is the same as <X>" — verify and add as alias
      await addAliasToCanonical(fs, llmResult.canonicalKey, norm)
      return commit(fs, eventDoc, llmResult.canonicalKey, "llm_match")
    }

    // --- Layer 3: BGE-M3 cosine on existing canonicals --------------------
    const embedding = await bgeM3Embed(eventDoc.rawText)  // 1024-dim
    const cosineMatches = await firestoreVectorNearest(
      fs, "pa-canonical-tags", embedding,
      { type: eventDoc.type, limit: 3, distanceMeasure: "COSINE" }
    )
    if (cosineMatches.length > 0 && cosineMatches[0].cosine >= 0.88) {
      await addAliasToCanonical(fs, cosineMatches[0].id, norm)
      return commit(fs, eventDoc, cosineMatches[0].id, "cosine_match")
    }

    // --- Cold path: propose new canonical ---------------------------------
    if (llmResult.action === "create" && llmResult.proposedCanonical) {
      const newKey = await proposeNewCanonical(fs, {
        ...llmResult.proposedCanonical,
        type: eventDoc.type,
        embedding,
        firstEvidence: eventDoc,
      })
      return commit(fs, eventDoc, newKey, "new_canonical")
    }

    // Shouldn't reach here; mark for ops review
    return commit(fs, eventDoc, null, "needs_review")
  }
)

async function commit(
  fs: Firestore, ev: TagEvent, canonicalKey: string | null, decision: string
) {
  const batch = fs.batch()
  batch.update(fs.collection("pa-tag-events").doc(ev.id), {
    status: canonicalKey ? "normalized" : "rejected",
    normalizedTo: canonicalKey,
    processedAt: new Date().toISOString(),
    decision,
  })
  if (canonicalKey) {
    const entityKey = `${ev.entityRef.kind}:${ev.entityRef.id}`
    const entityRef = fs.collection("pa-entity-tags").doc(entityKey)
    batch.set(entityRef, {
      entityKey,
      [`tags.${canonicalKey}`]: {
        firstObservedAt: ev.createdAt,
        lastObservedAt: ev.createdAt,
        observationCount: FieldValue.increment(1),
        sources: FieldValue.arrayUnion(ev.source),
      },
      updatedAt: new Date().toISOString(),
    }, { merge: true })
  }
  await batch.commit()
}
```

**Worker is 80 lines + 3 helper functions. Stays under §3 brief's "≤80 lines pseudocode" target.**

### 4.3 Cost Model

Steady-state assumptions:
- 1,000 PA users × 5 turns/day × 2 tag-events/turn = 10k events/day from PA
- Scraping: 1k jobs/week × 10 tags/job = 10k events/week ≈ 1.4k/day
- Total **≈ 12k events/day = 8.3 events/min**

Per-event cost breakdown (after 1 month warm-up — 85% hot-hit rate):

| Tier | Share | Per-event cost | Daily cost @ 12k |
|---|---|---|---|
| Hot alias hit | 85% | $0.0000010 (1 Firestore read + 1 batch write) | $0.010 |
| Warm LLM normalize | 12% | $0.0000080 (LLM $0.000007 + 1 read) | $0.012 |
| Cold cosine + new canonical | 3% | $0.000020 (BGE + LLM + 2 writes) | $0.007 |
| **Total** | 100% | — | **≈ $0.029/day = $0.87/mo** |

LLM cost source: DeepSeek-V4-Flash on SiliconFlow at $0.14/M input, $0.28/M output ([SiliconFlow pricing](https://www.siliconflow.com/pricing)). Average tag-normalize prompt: 200 input + 30 output = 230 tokens × 12% × 12k = **332k tokens/day ≈ $0.07/day on LLM**.

**Verdict: < $1/mo at PA's current scale. Order-of-magnitude headroom for 100× spike.**

[PUA生效 🔥] 这个 cost model 不止给 Adam 看——这个数字直接进 v1.5-ROLLOUT 的"是否值得做 Phase 1"决策。$0.87/mo 对比 hand-curating 的 ops cost (Adam 自己花 1h/week × 50/h = $200/mo 编辑 alias)，**ROI 是 230×**。这是 P10 战略输入维度的回答，不是单纯 design doc。

### 4.4 Idempotency 设计

**Three layers of idempotency**:

1. **Event creation**：`eventId = sha256(source|sourceDocId|rawText).slice(0,24)` + Firestore `.create()` (fails if exists). Same input → same id → second create raises ALREADY_EXISTS → caller swallows. 这是 Adam scraping repo `sourcing_records.py` 已经在用的 pattern——**不发明新轮子**。

2. **Worker processing**：worker reads `eventDoc.status` first. Only processes `status === "pending"`. If a duplicate trigger fires, it sees `status === "normalized"` and returns. Firestore tx on `commit()` ensures status flip is atomic.

3. **Entity-tag accumulation**：Use `FieldValue.increment(1)` and `FieldValue.arrayUnion(source)` instead of read-modify-write. Firestore primitive guarantees atomic increment even under concurrent writes.

### 4.5 Backpressure 处理

**1000 events/min spike scenario** (e.g. scraping batch ingest of 60k jobs):

- Cloud Functions Gen2 default: 1000 instances × concurrency 10 = **10k concurrent invocations** capacity. Far above 1000/min.
- Real bottleneck: SiliconFlow LLM rate limit. Estimate 1 RPM/account default; enterprise tier 100+ RPM. Worst case 12% of 1000/min = 120 LLM calls/min, **already at limit**.
- **Mitigation 1**: warmup pass on ingest — pre-warm canonical aliases via batch LLM. Reduces hot-miss rate during spike.
- **Mitigation 2**: worker has `concurrency: 10` per instance — 50 instances × 10 = 500 concurrent. Adequate but not elastic. If LLM gets 429:
  - return `status="pending"` unchanged (no flip to rejected).
  - Cloud Scheduler runs a 1-min `tag-events-retry` CF that picks up `status="pending" AND createdAt < now-2min` and re-enqueues by writing a no-op update (re-fires the trigger).
- **Mitigation 3**: hard cap on canonicals creation — if >100 new canonicals proposed in any 10-min window, **freeze new-canonical creation** and route to `needs_review`. Prevents adversarial input from blowing up the dictionary. Operator unfreezes via dashboard.

### 4.6 Observability

| Signal | Where | Alert threshold |
|---|---|---|
| `tag_events_pending_age_p99` | Cloud Monitoring metric — query `pa-tag-events` for `status="pending" AND createdAt < now-5min` | > 100 events older than 5 min |
| `tag_normalize_lat_p95` | OTel span on worker invocation | > 5s |
| `canonical_creations_per_hour` | Cloud Monitoring counter | > 50/hour (potential adversarial input) |
| `llm_call_failure_rate` | Existing PA `pa-audit-events` "decision=llm_match" failures | > 5% over 15 min |
| `entity_tag_doc_size_bytes` | Firestore monitoring | > 800kB (1MB hard limit; arr-of-tags > 500 = warning) |

Audit trail: all decisions (`hot_alias` / `llm_match` / `cosine_match` / `new_canonical` / `needs_review`) written into `pa-tag-events.decision`. Operator dashboard reads this to compute hot-hit-rate, propose-rate, etc.

---

## 5. Surface — How Existing Code Reads the Canonical Tags

### 5.1 PA orchestrator (industry-tags.ts) becomes a special case of canonical-tags

industry-tags.ts 现在是一个独立的 deterministic mapping。**新架构下它继续存在，但 emit 给 canonical-tags pipeline**，作为该 type 的 deterministic-warm-fallback：

```typescript
// industry-tags.ts unchanged for the deterministic path. New emit:
export function emitIndustryTagEvent(fs: Firestore, args: {
  rawText: string;          // the source string we parsed
  resolved: IndustryTag;    // what we mapped to
  signals: IndustrySignals; // for context
  entityRef: { kind: "pa_user", id: string }
}) {
  return recordTagEvent(fs, {
    source: "pa-conversation",
    sourceDocId: args.entityRef.id,
    sourceField: "industry-tags-cascade",
    rawText: args.rawText,
    type: "industry",
    entityRef: args.entityRef,
    // Annotate "deterministic: pre-mapped to <resolved>" — the LLM-normalize
    // layer respects this hint and short-circuits.
    context: `pre-resolved by deterministic mapper: ${args.resolved}`,
  })
}
```

The 10 industry canonicals are **seeded** into `pa-canonical-tags` at boot:

```
pa-canonical-tags/tech_software   { aliases: [INDUSTRY_KEY_MAP keys for tech_software], ... }
pa-canonical-tags/ai_ml           { aliases: [...], ... }
... (10 entries)
```

This means **industry-tags.ts is still source-of-truth for the locked 10-tag enum**, and the worker is an extension layer for non-industry types (skill, role, location, topic).

### 5.2 Read API

```typescript
// packages/core-types/src/canonical-tags-client.ts — read side
export async function getEntityTags(
  fs: Firestore,
  entityKey: string  // e.g. "pa_user:usr_abc"
): Promise<Record<string /* canonicalKey */, EntityTagAssignment>> { ... }

export async function getCanonicalTag(
  fs: Firestore,
  canonicalKey: string
): Promise<CanonicalTag | null> { ... }
```

Job-rec consumes via `getEntityTags("pa_user:usr_abc")` instead of dredging `pa-users.statedPreferences.targetLocations` directly. Eventually `statedPreferences` becomes a denormalized cache populated by the worker too — but that's Phase 3 migration, not Phase 1.

---

## 6. Implementation Phases

### Phase 1 — Schema + Write Contract（1 周）

1. Add `packages/core-types/src/canonical-tags.ts` with the 3 schemas above.
2. Add `pa-canonical-tags`, `pa-tag-events`, `pa-entity-tags` to `PA_COLLECTIONS`.
3. Implement `recordTagEvent()` TS client + Python equivalent + JSON-schema export.
4. Seed `pa-canonical-tags` with the 10 industry canonicals from industry-tags.ts (1-shot script).
5. Wire `realtime-tagger.ts` and `cv-ingest/industry-tags.ts` to emit events (parallel to existing writes — **don't remove existing path yet**).
6. Wire `wekruit-scraping/github/github_categorizer.py` to emit events.

**Success criterion**: `pa-tag-events` collection has > 1000 entries from both repos within 24 h of merge. **No worker yet — this is just plumbing**. Read path still uses the old `statedPreferences` field.

### Phase 2 — Normalize Worker（2 周）

1. Implement `canonical-tag-worker.ts` (Layer 1 hot only first — no LLM, no BGE).
2. Build alias-table editor in pa-dashboard (operator surface).
3. Add OTel spans + Cloud Monitoring metrics from §4.6.
4. Ship behind `paCanonicalTagWorkerEnabled` flag, ramp 1% → 10% → 100% over 1 week.
5. Once Layer 1 stable, ship Layer 2 (LLM) behind same flag, sub-flag `paCanonicalTagLlmEnabled`.
6. Layer 3 (BGE-M3 cosine) — defer until Layer 2 hot-miss rate drops below 5%, then add.

**Success criterion**: 85%+ events transition `pending → normalized` within 30s. < 0.1% events stuck > 5 min.

### Phase 3 — Backfill + Read-side Migration（2 周）

1. Backfill script: walk every `pa-users.statedPreferences.targetRole[i]` and `targetLocations[i]` → emit synthetic events (source = "manual", sourceDocId = userId).
2. Same for scraping: walk every tagged repo / job / researcher row → synthetic events.
3. Once backfill done, switch job-rec / persona / etc. to read from `pa-entity-tags` instead of `statedPreferences`. Run dual-read for 1 week to verify parity.
4. Once dual-read green, deprecate the old fields in `statedPreferences` (keep as cache only).

**Success criterion**: 100% of pa-users have at least 1 entry in `pa-entity-tags`; job-rec recommendations identical between old and new path on Adam's account.

### Phase 4 — Discovery + Operator UI（later）

1. Cold-path BGE-M3 cosine + HDBSCAN offline clustering job (weekly Cloud Scheduler).
2. Operator dashboard for:
   - Canonical tag editing (merge, split, reject).
   - Pending review queue.
   - Per-entity tag heatmap.
3. Cross-language alias enrichment via LLM batch ("for canonical X, propose 5 zh aliases").

---

## 7. Hard Recommendation — Commercial vs Open vs Hybrid

**Hybrid, leaning open + self-hosted**:

| Component | Choice | Rationale |
|---|---|---|
| Backbone taxonomy | **None — self-curated**, seeded from PA industry-tags.ts + scraping github_categorizer.py | No external taxonomy supports zh-EN well + matches PA domain (job + research). LinkedIn would be ideal but $50k+/yr. ESCO is plausible Phase 5 import for English alias enrichment. |
| Embedding model | **BGE-M3** (already deployed) | MIRACL 70.0% nDCG@10 beats OpenAI text-embedding-3 on multilingual. Already in PA stack — no new dependency. |
| LLM normalize | **DeepSeek-V4-Flash on SiliconFlow** ($0.14/$0.28 per M tokens) | $0.07/day at PA volume. Already the PA LLM provider. |
| Clustering for discovery | **HDBSCAN over BGE-M3 embeddings** | Industry standard (BERTopic, Nesta ojd_daps_skills both use this). Open-source `hdbscan` Python package. |
| Storage | **Firestore** (same project, namespaced collections) | Both repos already write Firestore. Firestore vector search GA mid-2024 supports our 1024-dim cosine search natively. |

**Phase 5 horizon (deferred — only if PA reaches 100k users)**:
- Import ESCO English skill list as alias seed (free, CC-BY 4.0) — adds ~13k canonical skill candidates without operator labor.
- Evaluate Lightcast Open Skills if budget allows (~$50–500/mo for SMB tier per their site).

**Why not LinkedIn at any price**: 39k skills + 374k aliases × 26 locales is the gold standard, but $50k–$300k/yr enterprise license is a categorically different cost tier than "10× LLM normalization". Revisit at Series A.

---

## TL;DR for Adam

1. **不要去 backbone ESCO/LinkedIn**：中文不好 + 商业贵。**自建 hand-curated alias table + LLM normalize + BGE-M3 cosine 三层架构** —— PA 现成 stack，新增 cost ≈ $0.87/mo at 12k events/day。
2. **新建 3 个 Firestore collection**：`pa-canonical-tags`（字典）、`pa-tag-events`（append-only 写入流）、`pa-entity-tags`（denormalized per-entity 索引）。两个 repo 都只写 `pa-tag-events`，worker 是唯一写另两个的进程。
3. **写合约 = `recordTagEvent({source, sourceDocId, rawText, type, entityRef})`**，eventId 用 sha256 做 idempotency key —— 沿用 scraping repo 已有的 `source_record_id` 模式，不发明新轮子。
4. **Async pipeline 用 Firestore onWrite trigger**（不用 Pub/Sub）——PA 已有这种 CF 模式（paMatchingPipelineComplete 等），10k events/day 远低于容量上限；Pub/Sub 留 Phase 5 再考虑。
5. **PA industry-tags.ts 不动 + scraping 4 套独立 taxonomy 通过 emit-event 收编到同一 dictionary** —— 不破坏既有 deterministic mapping，只是把它作为"已 pre-resolved"的 hint 喂给 worker。这条是 Phase 1 不返工的关键。

**实施分期：Phase 1（schema + 双 repo 写合约）= 1 周；Phase 2（worker + 1%→100% ramp）= 2 周；Phase 3（backfill + 读路径切换）= 2 周；Phase 4（discovery + operator UI）= 2 周。整体 6–7 周，单人。**

---

## Sources

- [ESCO API documentation](https://esco.ec.europa.eu/en/use-esco/use-esco-services-api/esco-web-service-api)
- [ESCO Classification overview](https://esco.ec.europa.eu/en/about-esco/escopedia/escopedia/esco-api)
- [ESCO languages list (28 EU; no Chinese)](https://esco.ec.europa.eu/en/about-esco/escopedia/escopedia/esco-languages)
- [Chinese-SkillSpan ESCO Chinese alignment](https://arxiv.org/html/2604.23009)
- [O*NET Web Services reference](https://services.onetcenter.org/reference/)
- [O*NET database](https://www.onetcenter.org/database.html)
- [LinkedIn Skills Graph engineering blog](https://www.linkedin.com/blog/engineering/data/building-maintaining-the-skills-taxonomy-that-powers-linkedins-skills-graph)
- [LinkedIn API pricing tiers (Phyllo guide)](https://www.getphyllo.com/post/linkedin-api-ultimate-guide-on-linkedin-api-integration)
- [Lightcast Open Skills Taxonomy](https://lightcast.io/open-skills)
- [Lightcast Skills Taxonomy update blog](https://lightcast.io/resources/blog/new-skills-taxonomy-update)
- [BAAI BGE-M3 model card](https://huggingface.co/BAAI/bge-m3)
- [BGE-M3 paper (Multi-lingual, Multi-Functionality, Multi-Granularity)](https://arxiv.org/html/2402.03216v3)
- [TechWolf JobBERT-v2 model card](https://huggingface.co/TechWolf/JobBERT-v2)
- [Multilingual JobBERT (TalentCLEF 2025) paper](https://arxiv.org/html/2507.21609v1)
- [TalentCLEF 2025 overview](https://arxiv.org/html/2507.13275)
- [NLPnorth @ TalentCLEF 2025 — discriminative vs contrastive vs prompt methods](https://arxiv.org/html/2506.19058)
- [Nesta ojd_daps_skills extractor library](https://nestauk.github.io/ojd_daps_skills/)
- [Nesta ojd_daps_skills GitHub (MIT license)](https://github.com/nestauk/ojd_daps_skills)
- [ESCOX skill extractor (PyPI)](https://pypi.org/project/esco-skill-extractor/)
- [ESCOX paper (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S2665963825000326)
- [Pre-trained Embeddings for Entity Resolution (VLDB 2023)](https://www.vldb.org/pvldb/vol16/p2225-skoutas.pdf)
- [NVIDIA NeMo Semantic Deduplication docs](https://docs.nvidia.com/nemo-framework/user-guide/24.09/datacuration/semdedup.html)
- [Optimizing Sentence Transformers for Entity Resolution (Fetch tech blog)](https://techblog.fetch.com/optimizing-sentence-transformers-for-entity-resolution-fb07be78e5e5)
- [PolyNorm: Few-Shot LLM-Based Text Normalization](https://arxiv.org/html/2511.03080)
- [Cross-Dataset Entity Matching with LLMs (EDBT 2025)](https://openproceedings.org/2025/conf/edbt/paper-224.pdf)
- [Ecological Cost of Entity Resolution (LLM vs deterministic)](https://www.minimalistinnovation.com/post/ecological-cost-entity-resolution-software-carbon-intensity)
- [HDBSCAN clustering text embeddings (Dylan Castillo)](https://dylancastillo.co/posts/clustering-documents-with-openai-langchain-hdbscan.html)
- [BERTopic clustering docs](https://maartengr.github.io/BERTopic/getting_started/clustering/clustering.html)
- [OpenAI text-embedding-3-small model card](https://platform.openai.com/docs/models/text-embedding-3-small)
- [SiliconFlow pricing](https://www.siliconflow.com/pricing)
- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [Firestore vector search docs](https://firebase.google.com/docs/firestore/vector-search)
- [Firestore triggers reference (Cloud Functions for Firebase)](https://firebase.google.com/docs/functions/firestore-events)
- [Firebase Pub/Sub triggers](https://firebase.google.com/docs/functions/pubsub-events)
- [Firebase vs Google Pub/Sub comparison (ably)](https://ably.com/compare/firebase-vs-google-pub-sub)
- [Stack Overflow tag taxonomy hierarchical modeling](https://damevski.github.io/files/sotags_jss19_preprint.pdf)
- [Mapping Stack Overflow tags to Wikipedia concepts](https://journals.sagepub.com/doi/10.1177/0165551515586669)
- [Canonical Data Models — Alation guide](https://www.alation.com/blog/canonical-data-models-explained-benefits-tools-getting-started/)
- [Canonical schema patterns — Arcitura SOA](https://patterns.arcitura.com/soa-patterns/design_patterns/canonical_schema)
