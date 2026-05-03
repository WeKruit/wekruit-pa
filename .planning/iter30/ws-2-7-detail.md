# iter30 — WS2 + WS7 Engineer Detail Plan

> **Owner**: Backend / data engineer (single body, paired across WS2 + WS7)
> **Total**: 6-7 weeks (P1 → P2 → P3 → P4 + WS7 phase)
> **Author**: WS2/7 detail-planner agent (P7 骨干模式)
> **Status**: DETAIL-PLAN — no production code yet
> **Date**: 2026-05-03
>
> [PUA生效 🔥] 阿里味方法论先行：Adam 这轮的核心抓手是"两仓共用一份字典 + 互斥英文 canonical"。我把它拆到字段级、拆到 onWrite race-condition 级。同事 Claude 写 plan 不能只到伪代码——必须到**线程模型**、**回滚动作**、**operator review SLA**——否则 P2 worker 上线第一周就在踩 Firestore lock contention。**闭环**才有 owner 意识。

---

## 0. Adam-locked constraints recap (do not violate)

1. **Tags English-only canonical** — single `displayName: string`, no `{zh, en}` split. Adam: "tag可以是纯英文". The bilingual `{zh, en}` shape from research doc §3.1 (line 180-183) is **superseded**.
2. **Mutual exclusion enforced at write time** — "prefer ML" and "prefer machine learning" must collapse to ONE entity-tag for a user. Confidence reinforced, not duplicated.
3. **Free Qwen2.5-7B-Instruct on SiliconFlow** for normalize LLM (NOT DeepSeek-V4-Flash from research doc §2.1).
4. **Cross-repo shared lib mandatory** — `@wekruit/shared-tags`, both PA + scraping (Python) consume.
5. **3 Firestore collections**: `pa-canonical-tags`, `pa-tag-events`, `pa-entity-tags`.
6. **Async via Firestore onWrite trigger** (Option A from research §4.1).
7. **No external taxonomy import** (no ESCO / Lightcast / LinkedIn).
8. **Self-curated dictionary** seeded from existing PA artifacts.

---

## 1. Task breakdown

### Phase 1 — Schema + Shared Lib + PA Realtime-Tagger Rewrite (1-2 weeks)

| ID | Task | ≤1d | Owner output |
|---|---|---|---|
| P1.1 | Author Zod schemas for 3 collections in `packages/core-types/src/canonical-tags.ts` (English-only displayName variant) | 0.5d | new file ~180 lines + index.ts re-export |
| P1.2 | Add 3 keys to `PA_COLLECTIONS` enum (`canonicalTags`, `tagEvents`, `entityTags`) | 0.25d | edit `collections.ts:5-49` |
| P1.3 | Scaffold `packages/shared-tags/` workspace package (TS, dual ESM/CJS, npm-ready) | 0.5d | new package — `package.json`, `tsconfig.json`, `src/{index,types,record-tag-event,sha256}.ts` |
| P1.4 | Implement `recordTagEvent()` TS client with sha256 idempotency + Firestore `.create()` race handling | 0.75d | `record-tag-event.ts` ~80 lines + tests |
| P1.5 | Generate JSON-Schema artifact from Zod via `zod-to-json-schema`; CI step to drop `dist/canonical-tags.schema.json` | 0.5d | new `scripts/emit-schema.mjs` |
| P1.6 | Author Python port `wekruit_shared_tags/` (Pydantic models + thin Firestore Admin SDK client) — cross-repo Option C | 1d | new directory in scraping repo (PR filed) |
| P1.7 | Seed script: walk `INDUSTRY_TAGS` (10) + `INDUSTRY_KEY_MAP` aliases (~250) + `AI_AGENT_SKILL_WEIGHTS` (30 rows) → emit canonical-tag docs | 0.75d | `apps/functions/scripts/seed-canonical-tags.mjs` |
| P1.8 | Rewrite `packages/pa-orchestrator/src/voice/realtime-tagger.ts` to call `recordTagEvent()` for each extracted signal **in parallel with existing statedPreferences write** (dual-write phase) | 0.75d | edit `realtime-tagger.ts:166-204` |
| P1.9 | Wire `apps/functions/src/cv-ingest/cv-ingest.ts` industry-tag emit via `emitIndustryTagEvent()` adapter | 0.5d | new file `cv-ingest/emit-tag-events.ts` |
| P1.10 | Unit tests: idempotency (same sha256 → no duplicate doc), schema round-trip (Zod ↔ JSON Schema), Python ↔ TS schema parity | 1d | tests in `packages/shared-tags/__tests__/` + `wekruit_shared_tags/tests/` |
| P1.11 | Deploy P1 (Firestore rules update, indexes for `pa-tag-events.status` + `pa-canonical-tags.aliases`, function deploy) — verify with synthetic event | 0.5d | deploy + smoke + 1 doc round-trip |

**Phase 1 acceptance**: `pa-tag-events` has > 1k entries from PA + scraping within 24h of merge. **No worker yet** — events sit in `pending` status. Read path unchanged.

### Phase 2 — Worker (normalize + dedupe) + alias-table seed (2-3 weeks)

| ID | Task | ≤1d | Owner output |
|---|---|---|---|
| P2.1 | `apps/functions/src/tag-worker/normalize.ts` — onCreate trigger skeleton + `commit()` helper with Firestore tx | 0.75d | new file ~120 lines |
| P2.2 | Layer 1: hot alias lookup via `pa-canonical-tags.where("aliases", "array-contains", norm)` query | 0.5d | function `hotAliasHit()` |
| P2.3 | Layer 2 prep: SiliconFlow Qwen-7B client via existing `packages/agent-runtime/src/openai-provider.ts` adapter (free-tier auth headers + JSON mode) | 0.75d | new file `tag-worker/llm-normalize.ts` |
| P2.4 | Layer 2: `llmNormalize()` function with few-shot prompt (50 known canonicals as samples) + structured-output JSON schema (`{action: "match"|"create"|"reject", canonicalKey?, proposedCanonical?}`) | 1d | prompt + JSON schema + tests |
| P2.5 | Layer 3: BGE-M3 embed via `@pa/memory.embedText` reuse, then **Firestore vector findNearest()** on `pa-canonical-tags.embedding` (Firestore vector search GA) — fallback to in-memory cosine if vectorIndex not deployed | 1d | `tag-worker/cosine-search.ts` + Firestore vector index migration |
| P2.6 | **Mutual-exclusion enforcement** at commit: if `pa-entity-tags/{entityKey}.tags[canonicalKey]` exists, increment `count` + arrayUnion `sources`; do **not** add a sibling key with semantic overlap | 0.75d | `commit()` extension + tests |
| P2.7 | Race-condition handling: on Layer 2 "create new canonical" + Layer 1 hot-miss → use Firestore tx with `.create()` (fails if existing) — fall through to alias add path on conflict | 0.5d | `proposeNewCanonical()` |
| P2.8 | Confidence calculation: `confidence = 0.4 * minMaxNorm(observationCount, 1, 50) + 0.4 * approvalSignal + 0.2 * sourceCountFactor` — implement at commit time | 0.5d | `confidence.ts` |
| P2.9 | Retry queue: scheduled function picks `pa-tag-events.status="pending" AND createdAt < now-2min` and re-enqueues via no-op update (re-fires trigger) | 0.5d | `tag-worker-retry.ts` (Cloud Scheduler 1-min cron) |
| P2.10 | Worker tests: hot-hit, llm-match, cosine-match, new-canonical, race (concurrent create), retry storm (50 events same eventId) | 1.5d | `tag-worker/__tests__/` |
| P2.11 | Observability: OTel span per layer + Cloud Monitoring metrics for `tag_events_pending_age_p99`, `canonical_creations_per_hour`, `llm_call_failure_rate` | 0.75d | `instrumentation/tag-worker-metrics.ts` |
| P2.12 | Flag-gated ramp: `paCanonicalTagWorkerEnabled` (1% → 10% → 100% over 1 week) | 0.25d | flag + ramp script |
| P2.13 | Deploy + 1-week ramp observation; tune Layer 2 LLM prompt against fixture | continuous | deploy report |

**Phase 2 acceptance**: 85%+ events transition `pending → normalized` within 30s; `tag_events_pending_age_p99 < 5min`; mutual-exclusion enforced (write-time test pass).

### Phase 3 — Backfill + Scraping Repo PR (1-2 weeks)

| ID | Task | ≤1d | Owner output |
|---|---|---|---|
| P3.1 | Backfill script: walk every `pa-users.statedPreferences.{targetRole, targetLocations}` → emit synthetic events with `source="manual-backfill"` | 0.5d | `scripts/backfill-pa-tags.mjs` |
| P3.2 | Backfill script: walk every `pa-candidate-resumes.skills[]` → emit skill events | 0.5d | `scripts/backfill-cv-skills.mjs` |
| P3.3 | Backfill script: walk every `pa-job-profiles.{prefersStartup, researchOriented, salaryFloor}` → emit preference events | 0.5d | `scripts/backfill-job-profiles.mjs` |
| P3.4 | Scraping repo PR: rewrite `wekruit-scraping/github/github_categorizer.py:CATEGORY_RULES` output path to call `wekruit_shared_tags.record_tag_event()` | 0.75d | scraping repo PR #1 |
| P3.5 | Scraping repo PR: rewrite `wekruit-scraping/devpost/scraper.py` tech-stack tags to emit events | 0.5d | scraping repo PR #2 |
| P3.6 | Scraping repo PR: rewrite `wekruit-scraping/researcher/pipeline/sourcing_records.py` (already uses sha256 + content_hash) — add tag-emit hook on researcher domain/venue extraction | 0.75d | scraping repo PR #3 |
| P3.7 | End-to-end test: scraping calls record_tag_event → PA worker normalizes → reads in PA via `getEntityTags("scraping_github_repo:foo/bar")` | 0.5d | integration test |
| P3.8 | Dual-read parity check: WS7 readers (see WS7 phase) read both `pa-users.statedPreferences` and `pa-entity-tags` for 1 week, log diff | 0.5d | observability dashboard panel |
| P3.9 | Deprecate old PA write-path on `targetLocations` / `targetRole` (keep `visaStatus` enum and `yoeRange` numeric — those don't go through entity-tags) | 0.5d | edit `realtime-tagger.ts` to drop dual-write |

**Phase 3 acceptance**: 100% of pa-users have ≥1 entry in `pa-entity-tags`; job-rec recommendations identical between old + new path on Adam's account (parity test).

### Phase 4 — HDBSCAN Discovery + Operator Review UI (1 week)

| ID | Task | ≤1d | Owner output |
|---|---|---|---|
| P4.1 | Daily scheduled function: read `pa-tag-events` where `decision="needs_review" OR confidence<0.6` last 7d → run HDBSCAN over BGE-M3 embeddings | 1d | `apps/functions/src/tag-worker/discovery.ts` |
| P4.2 | Promotion criteria: cluster `min_size ≥ 5` AND `density ≥ 0.7` AND `semantic_distinctness ≥ 0.3` (cosine to nearest existing canonical) → propose new canonical with `approvalStatus="proposed"` | 0.5d | `discovery.ts` extension |
| P4.3 | Operator-review queue page in dashboard (`/canonical-tags-review`) — list proposed canonicals + accept/reject/merge actions | 1d | `apps/dashboard-web/src/pages/CanonicalTagsReview.tsx` |
| P4.4 | Operator merge: when 2 canonicals are decided to be aliases, merge by moving aliases + entity-tags references atomically (Firestore tx + audit log) | 1d | `tag-worker/merge-canonicals.ts` |
| P4.5 | Auto-promotion threshold: `cluster_size ≥ 20 AND density ≥ 0.85 AND distinctness ≥ 0.4` → auto-approve (skip operator review) | 0.25d | edit P4.2 |
| P4.6 | Operator-review SLA: alert if proposed-queue depth > 50 for >24h | 0.25d | metric + alert |

**Phase 4 acceptance**: HDBSCAN runs daily, ≤10 false-positive promotions per 100 candidates (operator review log); operator can accept/reject from dashboard.

### WS7 Phase — Unified Profile Loader (parallel with P3-P4, 1-2 weeks)

| ID | Task | ≤1d | Owner output |
|---|---|---|---|
| W7.1 | `packages/pa-orchestrator/src/profile-loader.ts` — `loadUserProfile(userId): Promise<UserProfile>` single batch read of `pa-entity-tags/{userId}` | 0.5d | new file ~80 lines |
| W7.2 | `UserProfile` type defined in `core-types`: aggregates skills + preferences + roles + locations from entity-tags into typed shape | 0.5d | `packages/core-types/src/user-profile.ts` |
| W7.3 | RunContext (WS3) integration: `ctx.userProfile` populated at turn entry by `turn-loader.ts` calling `loadUserProfile(userId)` | 0.5d | edit `turn-loader.ts` (depends on WS3 land) |
| W7.4 | Decay logic: at READ time, compute `decayedConfidence = confidence * exp(-ln(2) * daysSinceLastReinforced / halfLife)` per type | 0.5d | `profile-loader.ts` extension |
| W7.5 | Per-type decay config: `preference: 180d`, `skill: never`, `role: never`, `location: 365d`, `trait: 180d`, `industry: never`, `experience: never` (open question: confirm with Adam) | 0.25d | `decay-config.ts` |
| W7.6 | Source attribution: `profile.entries[*].sources[]` exposes per-source `weight`, `at`, `count` for audit UI | 0.25d | type + read code |
| W7.7 | Reader migration: 5+ existing call sites that read `pa-users.statedPreferences.{targetRole,targetLocations,prefersStartup,researchOriented,salaryFloor}` → switch to `loadUserProfile()` | 1.5d | edits in `apps/job-rec/src/{daily-batch,hard-filter,cross-encoder-rerank}.ts` |
| W7.8 | BoostCalculator (WS8) uses `loadUserProfile().skills` instead of hand-walking CV skill list | 0.5d | edit `apps/job-rec/src/boost-calculator.ts` (cross-WS dependency) |
| W7.9 | Tests: source-merge correctness (PA + scraping → reinforced count), decay correctness, dual-read parity | 1d | new test files |

**WS7 acceptance**: All current preference/skill reads go through entity-tags; source attribution audit visible in UserDetail dashboard page; BoostCalculator reads entity-tags directly.

---

## 2. Schema specification (Zod, English-only)

### 2.1 `CanonicalTagSchema` (collection `pa-canonical-tags/{canonicalKey}`)

```typescript
// packages/core-types/src/canonical-tags.ts
import { z } from "zod"

export const CanonicalTagTypeSchema = z.enum([
  "skill",        // RAG, Python, embeddings, prompt-engineering
  "role",         // software-engineer, product-manager
  "industry",     // ai-ml, fintech-finance (re-uses INDUSTRY_TAGS keys, hyphen-case)
  "location",     // sf-bay-area, nyc, remote
  "preference",   // prefers-startup, research-oriented
  "trait",        // leadership, mentoring (cross-platform soft signals)
  "company",      // anthropic, openai, google
  "venue",        // neurips, icml (researcher pipeline)
  "topic",        // graph-neural-networks, retrieval-augmentation
  "experience",   // years-experience-bucket, fang-alum
])
export type CanonicalTagType = z.infer<typeof CanonicalTagTypeSchema>

export const CanonicalTagSchema = z.object({
  /** Stable short-form key. Lowercase kebab-case. NEVER changes after first
   *  approve. Used as Firestore doc ID. e.g. "machine-learning". */
  canonicalKey: z.string().regex(/^[a-z0-9-]+$/).min(2).max(64),

  type: CanonicalTagTypeSchema,

  /** ENGLISH-ONLY (Adam-locked iter30 2026-05-03 decision). No zh/en split.
   *  e.g. "Machine Learning". Title case for display. */
  displayName: z.string().min(1).max(80),

  /** All known free-text aliases that collapse to this canonical. Stored
   *  lowercase + normalized whitespace. Used by `array-contains` lookup. */
  aliases: z.array(z.string().min(1).max(120)).max(500),

  /** 1024-dim BGE-M3 embedding of `displayName`. Used for new-tag-vs-
   *  existing cosine search via Firestore vector findNearest. */
  embedding: z.array(z.number()).length(1024).optional(),

  /** Quality signal: 0..1. Auto-derived
   *    confidence = 0.4*minMax(observationCount,1,50)
   *               + 0.4*approvalSignal
   *               + 0.2*sourceCountFactor */
  confidence: z.number().min(0).max(1).default(0.5),

  /** Append-only evidence (capped at 10 most recent). */
  evidence: z.array(z.object({
    source: z.enum([
      "pa-realtime-tagger",
      "pa-cv-ingest",
      "pa-onboarding",
      "scraping-github",
      "scraping-devpost",
      "scraping-researcher",
      "scraping-job",
      "manual-operator",
      "manual-backfill",
    ]),
    sourceDocId: z.string(),
    sourceField: z.string(),
    rawText: z.string().max(500),
    observedAt: z.string(),
  })).max(10).default([]),

  approvalStatus: z.enum([
    "proposed",        // worker just created, awaiting auto/operator review
    "auto-approved",   // ≥5 evidence + confidence ≥0.9 (criteria from research §3.1)
    "human-approved",  // operator clicked accept
    "rejected",        // operator clicked reject; do not re-create
  ]).default("proposed"),

  /** Hierarchy parent (e.g. "python" → parent "programming-language"). Optional. */
  parentKey: z.string().regex(/^[a-z0-9-]+$/).nullable().optional(),

  /** **Mutual-exclusion group key** — Adam-locked. All canonical-tags with
   *  the same `mutexGroup` for the same `(entityKey, type)` collapse to ONE
   *  entity-tag. e.g. `mutexGroup="machine-learning"` for both
   *  canonical "machine-learning" and aliasing path "ml". When the worker
   *  decides one alias collapses to another canonical, both share mutexGroup. */
  mutexGroup: z.string().regex(/^[a-z0-9-]+$/).optional(),

  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CanonicalTag = z.infer<typeof CanonicalTagSchema>
```

### 2.2 `TagEventSchema` (collection `pa-tag-events/{eventId}`)

```typescript
export const TagEventSchema = z.object({
  /** sha256(source|sourceDocId|rawText|entityRef.kind|entityRef.id).slice(0,32)
   *  — idempotency key. Same content from same source for same entity → same
   *  eventId → second create raises ALREADY_EXISTS. */
  id: z.string().regex(/^[a-f0-9]{32}$/),

  source: z.enum([/* same enum as CanonicalTagSchema.evidence.source */]),
  sourceDocId: z.string(),       // pa_messages doc id, github full_name, etc.
  sourceField: z.string(),       // dot-path of the source field
  rawText: z.string().min(1).max(500),
  type: CanonicalTagTypeSchema,

  entityRef: z.object({
    kind: z.enum([
      "pa-user",
      "pa-job",                  // matching-jobs / pa-jobs collection
      "scraping-job",
      "scraping-researcher",
      "scraping-github-repo",
      "scraping-devpost-project",
    ]),
    id: z.string().min(1).max(200),
  }),

  /** Optional context to help LLM normalize. Surrounding sentence ≤500 chars. */
  context: z.string().max(500).optional(),

  status: z.enum(["pending", "normalized", "rejected", "skipped", "needs-review"])
    .default("pending"),

  /** canonicalKey if normalized. */
  normalizedTo: z.string().nullable().default(null),

  /** Decision trace for audit. */
  decision: z.enum([
    "hot-alias",        // Layer 1 hit
    "llm-match",        // Layer 2 LLM picked existing canonical
    "cosine-match",     // Layer 3 cosine ≥ 0.88 hit
    "new-canonical",    // Layer 2 LLM proposed create
    "needs-review",     // worker exhausted; goes to operator queue
    "skipped-mutex",    // collapsed by mutex check (already-tagged, no new entity write)
  ]).nullable().default(null),

  /** Worker-set confidence (0..1). */
  workerConfidence: z.number().min(0).max(1).nullable().default(null),

  createdAt: z.string(),
  processedAt: z.string().nullable().default(null),
  processingDurationMs: z.number().int().nonnegative().nullable().default(null),
})
export type TagEvent = z.infer<typeof TagEventSchema>
```

### 2.3 `EntityTagsSchema` (collection `pa-entity-tags/{entityKey}`)

Two-level shape: top-level doc holds metadata; tags are SUBCOLLECTION items so we don't blow Firestore 1MB doc limit when an entity hits 500+ tags.

```typescript
// pa-entity-tags/{entityKey}  (top-level doc)
export const EntityTagsRootSchema = z.object({
  /** Flattened key: "{kind}:{id}" so both repos share the namespace.
   *  e.g. "pa-user:usr_abc", "scraping-github-repo:openai/swarm". */
  entityKey: z.string(),

  /** Total active (non-decayed) tag count. Maintained by worker for cheap
   *  read of "does this user have any tags". */
  tagCount: z.number().int().nonnegative().default(0),

  updatedAt: z.string(),
})
export type EntityTagsRoot = z.infer<typeof EntityTagsRootSchema>

// pa-entity-tags/{entityKey}/items/{canonicalKey}  (subcollection)
export const EntityTagAssignmentSchema = z.object({
  canonicalKey: z.string().regex(/^[a-z0-9-]+$/),
  type: CanonicalTagTypeSchema,

  /** Mutex group. When worker tries to add a different canonical for same
   *  mutexGroup, it instead increments THIS entry's count and merges sources.
   *  Adam-locked: "tag只要是互相exclude就行". */
  mutexGroup: z.string().regex(/^[a-z0-9-]+$/),

  /** 0..1 — read-time decayed by `loadUserProfile`. Stored as raw at-write. */
  confidence: z.number().min(0).max(1).default(0.5),

  firstSeen: z.string(),
  lastReinforced: z.string(),
  /** Total observation count across all sources. */
  count: z.number().int().nonnegative().default(1),

  /** Source attribution — append-only via FieldValue.arrayUnion. */
  sources: z.array(z.object({
    source: z.string(),         // "pa-cv-ingest", etc.
    weight: z.number().min(0).max(1).default(1.0),
    firstAt: z.string(),
    lastAt: z.string(),
    count: z.number().int().positive().default(1),
  })).max(20),

  /** Per-type half-life (days) — 0 means "never decay". */
  decayHalfLifeDays: z.number().int().nonnegative().default(0),
})
export type EntityTagAssignment = z.infer<typeof EntityTagAssignmentSchema>
```

### 2.4 Schema diff diagram (text)

```
BEFORE (today)                            AFTER (P1+P2+P3 land)

pa-users/{userId}                         pa-users/{userId}
  ├─ statedPreferences                      ├─ statedPreferences (kept for
  │   ├─ targetRole[]   ←── free text       │   non-tag fields: visaStatus,
  │   ├─ targetLocations[] ←── free text    │   yoeRange, salaryFloor)
  │   ├─ visaStatus    ←── enum (kept)      │   ├─ visaStatus (kept)
  │   ├─ yoeRange      ←── tuple (kept)     │   ├─ yoeRange (kept)
  │   ├─ prefersStartup ←── bool            │   └─ salaryFloor (kept)
  │   ├─ researchOriented ←── bool          └─ ...
  │   └─ salaryFloor   ←── number
  └─ ...                                  pa-entity-tags/pa-user:usr_abc
                                            ├─ tagCount: N
pa-candidate-resumes/{userId}               └─ items/{canonicalKey} (subcoll)
  ├─ skills: string[]   ←── free text           ├─ canonicalKey: "machine-learning"
                                                ├─ type: "skill"
matching-jobs/{jobId}                           ├─ confidence: 0.92
  ├─ industryKey: string                        ├─ count: 5
                                                └─ sources: [{source, weight, ...}]

industry-tags.ts (TS const)               pa-canonical-tags/{canonicalKey}
  ├─ INDUSTRY_TAGS [10 strings]             ├─ canonicalKey: "machine-learning"
  ├─ INDUSTRY_KEY_MAP [~250 alias→tag]      ├─ type: "skill"
                                            ├─ displayName: "Machine Learning"
scraping/github_categorizer.py              ├─ aliases: ["ml", "machine learning",
  ├─ CATEGORY_RULES [12 regex buckets]      │             "ml/ai", ...]
  ├─ BIG_TECH_ORGS [~26 strings]            ├─ embedding: [...1024]
                                            ├─ confidence: 0.95
                                            ├─ approvalStatus: "human-approved"
                                            └─ mutexGroup: "machine-learning"

                                          pa-tag-events/{eventId}  (append-only)
                                            ├─ source: "pa-realtime-tagger"
                                            ├─ rawText: "prefer ML"
                                            ├─ entityRef: {kind, id}
                                            ├─ status: "normalized"
                                            ├─ normalizedTo: "machine-learning"
                                            └─ decision: "llm-match"
```

---

## 3. `recordTagEvent()` contract

### 3.1 TypeScript signature

```typescript
// packages/shared-tags/src/record-tag-event.ts
import type { Firestore } from "firebase-admin/firestore"
import type { CanonicalTagType, TagEvent } from "@pa/core-types"
import { sha256 } from "./sha256.js"

export type RecordTagEventArgs = {
  source: TagEvent["source"]
  sourceDocId: string                       // verbatim from caller
  sourceField: string                       // dot-path
  rawText: string                           // verbatim user/scraper text
  type: CanonicalTagType
  entityRef: TagEvent["entityRef"]
  context?: string                          // optional ≤500 chars
}

export type RecordTagEventResult = {
  eventId: string
  created: boolean    // false if duplicate (idempotency hit)
  reason?: "duplicate" | "validation-error"
}

export async function recordTagEvent(
  fs: Firestore,
  args: RecordTagEventArgs
): Promise<RecordTagEventResult>
```

### 3.2 Idempotency key construction

```typescript
const idempotencyInput = [
  args.source,
  args.sourceDocId,
  args.rawText.toLowerCase().trim(),
  args.entityRef.kind,
  args.entityRef.id,
].join("|")
const eventId = sha256(idempotencyInput).slice(0, 32)
```

Rationale:
- `source` ensures PA-realtime and scraping-github writing same `rawText` for same entity produce **different** events (we want both for source attribution).
- `sourceDocId` distinguishes per-message events (same `rawText` two turns apart should both count).
- `rawText` lowercased+trimmed (collapses "ML" / "ml" / " ML " noise).
- `entityRef.{kind,id}` so two different users saying the same thing produce different events.

### 3.3 Error handling

| Error | Behavior |
|---|---|
| Validation fails (Zod parse) | Return `{eventId: "", created: false, reason: "validation-error"}` and log to PA audit. Caller (realtime-tagger) treats as no-op. |
| `ALREADY_EXISTS` on `.create()` | Return `{eventId, created: false, reason: "duplicate"}`. Not an error — idempotent design. |
| Firestore quota exceeded / network | **Throw** to caller. Realtime-tagger wraps in fire-and-forget try/catch and logs `pa.shared_tags.write_failed` (no user-facing impact since fire-and-forget). |
| `args.rawText.length > 500` | Truncate to 500 chars + log warning. Don't reject — preserves data. |
| `args.entityRef.id` empty | Reject with validation-error — must have target entity. |

### 3.4 Cross-repo strategy — Pick **Option C: TS package + Python port**

Rationale:
- **Option a (HTTP shim)**: rejected. Adds latency to scraping (1k jobs/day batch import would shim 5k events through HTTPS). Also creates new prod surface that must be deployed/monitored. Adam constraint "不允许过度设计" (scraping repo `AGENTS.md` line 7).
- **Option b (shared schema only)**: rejected. Each repo re-implements the sha256 idempotency rule + Firestore .create() retry semantics → drift risk. Adam locked: "schema 必须在两边的 SDK 都暴露". Two implementations means two bug surfaces.
- **Option c (TS package + Python port)**: **WIN**. TS package is workspace-internal (`packages/shared-tags/`), Python package mirrors with `wekruit_shared_tags/` in scraping repo. Both consume **the same JSON-Schema artifact** (`canonical-tags.schema.json`) emitted from Zod via CI. Idempotency key construction is **byte-identical** because `sha256(string)` is deterministic.

Implementation:

```
wekruit-pa/                                    wekruit-scraping/
├── packages/shared-tags/                      ├── wekruit_shared_tags/
│   ├── src/                                   │   ├── __init__.py
│   │   ├── index.ts                           │   ├── record_tag_event.py
│   │   ├── record-tag-event.ts                │   ├── sha256_id.py
│   │   ├── sha256.ts                          │   ├── types.py        (Pydantic)
│   │   └── types.ts                           │   └── tests/
│   ├── dist/canonical-tags.schema.json ◄──────┼─── reads SAME file
│   └── package.json                           └── pyproject.toml
```

CI step (added to PA `.github/workflows/`): on `core-types` schema change, regenerate JSON Schema and PR-check both repos consume same `schemaVersion`. Schema versioning via `schemaVersion: "v1"` field on every event (added to TagEventSchema as required). Breaking schema bump → both repos must update before PA merges.

### 3.5 Python equivalent signature

```python
# wekruit_shared_tags/record_tag_event.py
from typing import Literal, TypedDict, Optional
from google.cloud.firestore import Client

class EntityRef(TypedDict):
    kind: str
    id: str

class RecordTagEventArgs(TypedDict, total=False):
    source: str
    source_doc_id: str          # snake_case at Python boundary; serialized as
    source_field: str           # camelCase to Firestore via TYPE_MAP
    raw_text: str
    type: str
    entity_ref: EntityRef
    context: Optional[str]

class RecordTagEventResult(TypedDict):
    event_id: str
    created: bool
    reason: Optional[str]

def record_tag_event(
    fs: Client,
    args: RecordTagEventArgs,
) -> RecordTagEventResult:
    ...
```

snake↔camel handled at serialization boundary by an explicit field-name map (no auto-camelCase magic), so both sides write identical Firestore documents. This is verified by the schema-parity test (P1.10).

---

## 4. Worker logic (normalize + dedupe) pseudocode

```typescript
// apps/functions/src/tag-worker/normalize.ts  (~115 lines incl. helpers)

export const canonicalTagWorker = onDocumentCreated({
  document: "pa-tag-events/{eventId}",
  region: "us-central1",
  timeoutSeconds: 60,
  concurrency: 10,
  maxInstances: 50,
  retry: false,    // we drive retry via tag-worker-retry scheduled fn
}, async (event) => {
  const startMs = Date.now()
  const ev = event.data?.data() as TagEvent | undefined
  if (!ev || ev.status !== "pending") return                       // [a]

  const fs = getFirestore()
  const norm = normalizeRawText(ev.rawText)                        // [b]

  try {
    // ─── Layer 1: Hot alias lookup ─────────────────────────────
    const hot = await fs.collection("pa-canonical-tags")
      .where("type", "==", ev.type)
      .where("aliases", "array-contains", norm)
      .limit(1).get()
    if (!hot.empty) {
      return await commit(fs, ev, hot.docs[0].id, "hot-alias", 1.0)
    }

    // ─── Layer 2: Qwen-7B normalize ────────────────────────────
    const knownCanonicals = await sampleCanonicals(fs, ev.type, 50)
    const llm = await llmNormalize({                               // [c]
      raw: ev.rawText,
      type: ev.type,
      context: ev.context,
      knownCanonicals,
      timeout: 1500,
    })
    if (llm.action === "match" && llm.canonicalKey) {
      // Verify the canonical exists, then add alias + commit.
      const canRef = fs.collection("pa-canonical-tags").doc(llm.canonicalKey)
      const canDoc = await canRef.get()
      if (canDoc.exists) {
        await canRef.update({
          aliases: FieldValue.arrayUnion(norm),
          updatedAt: new Date().toISOString(),
        })
        return await commit(fs, ev, llm.canonicalKey, "llm-match", llm.confidence)
      }
    }

    // ─── Layer 3: BGE-M3 cosine search ─────────────────────────
    const embed = await bgeM3Embed(ev.rawText)                     // [d]
    const candidates = await fs.collection("pa-canonical-tags")
      .where("type", "==", ev.type)
      .findNearest("embedding", embed, {
        limit: 3, distanceMeasure: "COSINE",
      }).get()
    const top = candidates.docs[0]
    if (top && cosineDistance(top) <= (1 - 0.88)) {
      await top.ref.update({ aliases: FieldValue.arrayUnion(norm) })
      return await commit(fs, ev, top.id, "cosine-match", 0.88)
    }

    // ─── Cold path: propose new canonical ──────────────────────
    if (llm.action === "create" && llm.proposedCanonical) {
      const newKey = await proposeNewCanonical(fs, {               // [e]
        canonicalKey: llm.proposedCanonical.canonicalKey,
        displayName: llm.proposedCanonical.displayName,
        type: ev.type,
        embedding: embed,
        firstEvidence: ev,
        mutexGroup: llm.proposedCanonical.canonicalKey,            // self-mutex
      })
      return await commit(fs, ev, newKey, "new-canonical", 0.6)
    }

    return await commit(fs, ev, null, "needs-review", null)        // [f]
  } catch (err) {
    log("pa.tag_worker.error", { eventId: ev.id, err: String(err) })
    // Don't flip status; retry scheduled fn will pick up.
    return
  } finally {
    log("pa.tag_worker.done", { eventId: ev.id, durationMs: Date.now() - startMs })
  }
})

async function commit(
  fs: Firestore, ev: TagEvent, canonicalKey: string | null,
  decision: TagEvent["decision"], workerConfidence: number | null
) {
  // Tx ensures status flip + entity-tag upsert are atomic.
  await fs.runTransaction(async (tx) => {
    const eventRef = fs.collection("pa-tag-events").doc(ev.id)
    const eventSnap = await tx.get(eventRef)
    const cur = eventSnap.data() as TagEvent | undefined
    if (!cur || cur.status !== "pending") return                   // [g] race-safe

    tx.update(eventRef, {
      status: canonicalKey ? "normalized" : "needs-review",
      normalizedTo: canonicalKey,
      decision,
      workerConfidence,
      processedAt: new Date().toISOString(),
      processingDurationMs: Date.now() - new Date(ev.createdAt).getTime(),
    })

    if (!canonicalKey) return

    // ── Mutual-exclusion enforcement ─────────────────────────
    const canRef = fs.collection("pa-canonical-tags").doc(canonicalKey)
    const canSnap = await tx.get(canRef)
    const mutexGroup = canSnap.data()?.mutexGroup ?? canonicalKey  // [h]

    const entityKey = `${ev.entityRef.kind}:${ev.entityRef.id}`
    const itemRef = fs.collection("pa-entity-tags").doc(entityKey)
      .collection("items").doc(canonicalKey)

    // Check if a SIBLING canonical with same mutexGroup already tags this entity.
    const siblings = await fs.collection("pa-entity-tags").doc(entityKey)
      .collection("items").where("mutexGroup", "==", mutexGroup).limit(1).get()
    if (!siblings.empty && siblings.docs[0].id !== canonicalKey) {
      // Mutex collision — reinforce sibling instead of writing new entry.
      const sibRef = siblings.docs[0].ref
      tx.update(sibRef, {
        count: FieldValue.increment(1),
        lastReinforced: new Date().toISOString(),
        sources: mergeSourceArray(siblings.docs[0].data().sources, ev.source),
      })
      tx.update(eventRef, { decision: "skipped-mutex", normalizedTo: siblings.docs[0].id })
      return
    }

    // No mutex collision — upsert.
    tx.set(itemRef, {
      canonicalKey, type: ev.type, mutexGroup,
      confidence: workerConfidence ?? 0.5,
      firstSeen: ev.createdAt,
      lastReinforced: ev.createdAt,
      count: FieldValue.increment(1),
      sources: mergeSourceArray(canSnap.data()?.sources ?? [], ev.source),
      decayHalfLifeDays: DECAY_HALF_LIFE_BY_TYPE[ev.type] ?? 0,
    }, { merge: true })

    tx.update(fs.collection("pa-entity-tags").doc(entityKey), {
      tagCount: FieldValue.increment(1),
      updatedAt: new Date().toISOString(),
    }, { merge: true })
  })
}
```

### 4.1 Race-condition coverage

| Race | Mitigation |
|---|---|
| Two workers fire on same `pa-tag-events/{eventId}` (Firestore at-least-once) | `[a]` early-return on `status !== "pending"`; `[g]` re-check inside tx; idempotent. |
| Worker A creates new canonical X, Worker B simultaneously decides B's input is X | `[e]` `proposeNewCanonical()` uses `.create()` which fails on existing doc; on collision, fall through to "alias-add" path on existing canonical. |
| Worker A processes event 1 for user U, Worker B event 2 (different rawText, same canonical, same user) — both want to write entity-tag | Firestore tx + `FieldValue.increment(1)`: serializes to single counter increment. `arrayUnion` on sources is also atomic. |
| Mutex collision (canonical X and canonical Y both tag user U with same mutexGroup) | `[h]` tx reads sibling with `where mutexGroup ==` query; if found, reinforces sibling instead of writing new — second canonical's entity-tag is **never created**. |
| Operator merges two canonicals (P4.4) while a worker is mid-tx with the about-to-be-deleted canonical | Merge function quiesces by setting `approvalStatus: "merging"`; worker checks this in `[c]` and routes the event to `needs-review` for re-processing post-merge. |

### 4.2 Confidence calculation

```typescript
function computeConfidence(c: CanonicalTag): number {
  const obs = clamp(c.evidence.length / 50, 0, 1)
  const apr = c.approvalStatus === "human-approved" ? 1
            : c.approvalStatus === "auto-approved"  ? 0.7
            : c.approvalStatus === "proposed"       ? 0.4
            : 0
  const srcCount = new Set(c.evidence.map(e => e.source)).size
  const srcFactor = clamp(srcCount / 5, 0, 1)
  return 0.4 * obs + 0.4 * apr + 0.2 * srcFactor
}
```

Rationale: blends observation density (40%), human approval (40%), source diversity (20%). Source diversity matters: a tag observed by 5 different pipelines is more trustworthy than 50 events from one pipeline.

---

## 5. HDBSCAN discovery

### 5.1 Daily scheduled function

```typescript
// apps/functions/src/tag-worker/discovery.ts
export const tagDiscoveryDaily = onSchedule({
  schedule: "every day 03:00",
  region: "us-central1",
  timeoutSeconds: 540,
}, async () => {
  const fs = getFirestore()
  // 1. Pull recent low-confidence events.
  const events = await fs.collection("pa-tag-events")
    .where("decision", "in", ["needs-review", "new-canonical"])
    .where("createdAt", ">=", isoMinusDays(7))
    .limit(5000)
    .get()
  if (events.size < 50) return  // not enough signal

  // 2. Embed all rawTexts via BGE-M3 (batch).
  const points = await batchEmbed(events.docs.map(d => d.data().rawText))

  // 3. HDBSCAN cluster.
  const clusters = hdbscan({
    points,
    minClusterSize: 5,           // promotion threshold
    minSamples: 3,
    metric: "cosine",
  })

  // 4. For each cluster, propose canonical (or skip if dense neighbor exists).
  for (const cluster of clusters) {
    const centroid = computeCentroid(cluster.points)
    const proposed = await llmNameCluster(cluster.examples, ev.type)  // Qwen-7B

    // Check semantic distinctness against existing canonicals.
    const nearest = await fs.collection("pa-canonical-tags")
      .where("type", "==", ev.type)
      .findNearest("embedding", centroid, { limit: 1, distanceMeasure: "COSINE" })
      .get()
    const distinctness = nearest.empty ? 1
      : 1 - cosineSimilarity(centroid, nearest.docs[0].data().embedding)

    const auto = cluster.size >= 20 && cluster.density >= 0.85 && distinctness >= 0.4
    const promote = cluster.size >= 5 && cluster.density >= 0.7 && distinctness >= 0.3

    if (promote) {
      await fs.collection("pa-canonical-tags").doc(proposed.canonicalKey).create({
        ...proposed,
        embedding: Array.from(centroid),
        approvalStatus: auto ? "auto-approved" : "proposed",
        evidence: cluster.examples.slice(0, 10),
        confidence: auto ? 0.75 : 0.5,
        mutexGroup: proposed.canonicalKey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
  }
})
```

### 5.2 Promotion criteria

| Tier | min_size | density | distinctness | Action |
|---|---|---|---|---|
| **Auto-promote** | ≥ 20 | ≥ 0.85 | ≥ 0.4 | Create canonical with `approvalStatus: "auto-approved"`, mark `confidence: 0.75`. Worker future events can collapse to it. |
| **Operator-review** | ≥ 5 | ≥ 0.70 | ≥ 0.3 | Create canonical with `approvalStatus: "proposed"`, append to `/canonical-tags-review` queue. |
| **Skip** | < 5 OR density < 0.70 OR distinctness < 0.3 | — | — | Leave events as `needs-review`; reconsider in 7 days. |

### 5.3 Operator review gate

Page `/canonical-tags-review` shows:
- Proposed canonical name + 10 example rawTexts
- Nearest-neighbor canonical (so operator sees "is this just an alias of X?")
- Buttons: **Accept** (→ `human-approved`), **Reject** (→ `rejected`, blacklist), **Merge with…** (collapse into existing canonical, move aliases + entity-tags)

Auto-promoted canonicals also surface here for **post-hoc review** — operator can demote `auto-approved` to `human-approved` (no-op except for confidence bump) or to `rejected` (triggers cleanup + entity-tag re-routing).

---

## 6. Cost model verification (12k events/day)

Recomputing the research doc's $0.87/mo estimate with **Adam-locked Qwen-7B (free)** instead of DeepSeek-V4-Flash.

| Component | Volume | Unit cost | Daily | Monthly |
|---|---|---|---|---|
| **Qwen-7B normalize** (Layer 2) | 12% miss × 12k = 1,440 calls/day × 230 tokens = 331k tokens | **$0/M (SiliconFlow free tier)** | $0 | **$0** |
| **BGE-M3 embed** (Layer 3 + discovery) | ~500 cosine calls/day × 1024-dim | SiliconFlow free tier (BGE-M3 included) per [siliconflow.com/pricing](https://www.siliconflow.com/pricing) | **$0** | **$0** |
| **Firestore reads** | 12k events × ~3 reads (canonical lookup + cosine candidates + evidence sample) = 36k/day | $0.06/100k = $0.0000006/read | $0.0216 | **$0.65** |
| **Firestore writes** | 12k events × 2 writes (event status flip + entity-tag upsert) = 24k/day | $0.18/100k = $0.0000018/write | $0.0432 | **$1.30** |
| **Firestore vector index** | `pa-canonical-tags.embedding` (1024-dim, ~5k canonical-tags steady-state) | $0.18/GiB/mo (storage) + free vector queries up to 100/sec | ~5k × 1024 × 4B / 1Gi = 0.02 GiB → $0.004/mo | **$0.005** |
| **Cloud Functions Gen2 invocations** | 12k events × 1 invocation + retry buffer 10% = 13.2k/day | $0.40/M = $0.0000004/inv | $0.005 | **$0.16** |
| **Cloud Functions Gen2 compute** | 13.2k × 0.4s avg × 256MB | $0.0000025/GBs | $0.014 | **$0.42** |
| **Cloud Scheduler** (retry every 1min) | 1440 invocations/day | $0.10/job/mo | — | **$0.10** |
| **HDBSCAN daily scheduled** | 1 invocation/day × 30s × 1GB | — | — | **$0.05** |
| **TOTAL** | | | | **≈ $2.69/mo** |

**Verdict on research doc divergence**: research doc said $0.87/mo but **omitted Cloud Functions compute + Firestore vector index storage + Cloud Scheduler costs**. Real bill at 12k events/day is **$2.69/mo** — **3.1× the research-doc estimate but still under the $1.50 acceptance gate the PLAN.md set on line 135**.

[PUA生效 🔥] **Flag for Adam**: PLAN.md WS2 acceptance gate is `≤ $1.50/mo`. My honest estimate is **$2.69/mo**. Either (a) loosen the gate to $5/mo (still 70× ROI vs operator $200/mo), or (b) skip the retry Cloud Scheduler (saves $0.10) + downgrade worker memory 256→128MB (saves ~$0.20) = $2.39/mo, still over. Recommendation: **loosen the gate**. The research doc forgot infra overhead — that's a planning bug, not a real cost overrun.

**100×-spike envelope**: at 1.2M events/day, the bill scales linearly to ~$270/mo on Firestore + free LLM. That's the cliff to watch when scraping ramps.

---

## 7. WS7 — Profile loader API

### 7.1 `loadUserProfile()` design

```typescript
// packages/pa-orchestrator/src/profile-loader.ts
import type { Firestore } from "firebase-admin/firestore"
import type { CanonicalTagType, EntityTagAssignment } from "@pa/core-types"

export type UserProfileEntry = {
  canonicalKey: string
  type: CanonicalTagType
  displayName: string                // joined from canonical-tags lookup
  confidence: number                 // **decayed at read time**
  rawConfidence: number              // pre-decay value
  count: number
  firstSeen: string
  lastReinforced: string
  daysSinceReinforced: number
  sources: Array<{ source: string; weight: number; count: number }>
}

export type UserProfile = {
  userId: string
  loadedAt: string
  tagCount: number
  // Grouped by type for ergonomic consumption.
  skills: UserProfileEntry[]
  preferences: UserProfileEntry[]
  roles: UserProfileEntry[]
  locations: UserProfileEntry[]
  industries: UserProfileEntry[]
  traits: UserProfileEntry[]
  companies: UserProfileEntry[]
  topics: UserProfileEntry[]
  experience: UserProfileEntry[]
}

export async function loadUserProfile(
  fs: Firestore,
  userId: string,
  opts?: { minConfidence?: number; topKPerType?: number }
): Promise<UserProfile>
```

Implementation:
1. Single batch read: `pa-entity-tags/pa-user:{userId}/items` (single collection scan, ordered by `count desc`).
2. Batched `getAll()` for the canonical-tags referenced (typically 20-100 docs).
3. Apply read-time decay: `decayedConf = rawConf * exp(-ln(2) * daysSinceReinforced / halfLifeDays)` — skip if `halfLifeDays === 0`.
4. Drop entries below `minConfidence` (default 0.2).
5. Group by type, sort by decayed confidence desc, slice `topKPerType` (default unlimited).

### 7.2 RunContext (WS3) integration

`turn-loader.ts` (built by WS3) batches turn-entry Firestore reads. WS7 contributes `userProfile`:

```typescript
// packages/pa-orchestrator/src/turn-loader.ts (WS3 file, WS7 contributes one read)
const ctx: ClaireContext = {
  userId,
  ...,
  userProfile: await loadUserProfile(fs, userId, { minConfidence: 0.3 }),
  ...,
}
```

Latency budget: `loadUserProfile` should target ≤80ms p95 (single subcollection scan + batched canonical lookups). Caching layer at WS3 level: 30s TTL per userId is acceptable for steady-state — voice handler doesn't need sub-second freshness because real-time tagger is fire-and-forget anyway.

### 7.3 Decay logic — read-time vs write-time?

**Decision: read-time** (with stored raw `confidence` + `lastReinforced`).

Rationale:
- Write-time decay would require periodic sweep across all entity-tags (60M+ writes if 1M users × 60 tags/user × periodic update). $$$.
- Read-time decay is computed in the hot turn path, but it's pure math (~5μs per entry × 60 entries = 0.3ms) — negligible.
- Write-time only decays on access — entries that aren't read can drift.
- Per-type half-life config lives in code (`DECAY_HALF_LIFE_BY_TYPE`), so no Firestore write needed to change it.

```typescript
// per-type config (open question: confirm with Adam)
const DECAY_HALF_LIFE_BY_TYPE: Record<CanonicalTagType, number> = {
  preference: 180,
  skill: 0,         // skills don't decay (open question)
  role: 0,          // roles don't decay
  industry: 0,
  experience: 0,
  location: 365,    // 1 year — locations can shift
  trait: 180,
  company: 0,       // company history is permanent
  venue: 0,
  topic: 365,       // research interests can shift
}
```

### 7.4 Source attribution surface

`UserDetail.tsx` dashboard (existing) gets a new "Tag Provenance" panel: per tag, show `sources[]` array as a stacked bar with source labels + counts. Clicking expands to show evidence rawTexts (read from `pa-tag-events` filtered by `entityRef + normalizedTo == canonicalKey`).

This answers "why does Claire know I prefer ML" → audit trail visible to operator.

---

## 8. Migration: existing data → entity-tags

### 8.1 Field-by-field mapping

| Source field (BEFORE) | Entity-tag canonical (AFTER) | Migration script | Notes |
|---|---|---|---|
| `pa-users.statedPreferences.targetRole[]` | type=`role`, canonical from `mapRoleToCanonical()` (new function — uses LLM Qwen-7B for free) | `scripts/backfill-pa-tags.mjs` | Free-text → canonical via P2 worker pipeline |
| `pa-users.statedPreferences.targetLocations[]` | type=`location`, e.g. "SF Bay Area" → `sf-bay-area` | same script | Already partly normalized in realtime-tagger; just replay events |
| `pa-users.statedPreferences.visaStatus` | **STAY in statedPreferences** (enum, not free text) | n/a | Mutually-exclusive enum doesn't need ontology layer |
| `pa-users.statedPreferences.yoeRange` | **STAY in statedPreferences** (numeric tuple) | n/a | Numeric range, not a tag |
| `pa-users.statedPreferences.prefersStartup` | type=`preference`, `prefers-startup` (true/false drops the entry on false) | same script | Boolean → 0/1 entity-tag confidence |
| `pa-users.statedPreferences.researchOriented` | type=`preference`, `research-oriented` | same script | Same |
| `pa-users.statedPreferences.salaryFloor` | **STAY** (numeric) | n/a | |
| `pa-job-profiles.{onboarding state, preferences}` | merge with above; `pa-job-profiles` is overlap | same script | Onboarding state stays; preference duplicates dedupe via mutex |
| `pa-candidate-resumes.skills[]` | type=`skill` per skill string | `scripts/backfill-cv-skills.mjs` | LLM normalize each free-text skill |
| `pa-candidate-resumes.industryTags[]` | type=`industry`, already canonical (10-tag enum) | seed script | Direct alias to `pa-canonical-tags/{industry-key}` |
| `pa-candidate-resumes.workHistory[].company` | type=`company`, `companyName` mapped via existing `COMPANY_INDUSTRY_MAP` | same script | Each role contributes a company tag |
| `pa-candidate-resumes.workHistory[].title` | type=`role` | same script | LLM normalize |
| `Mem0 entries` (semantic memory) | **SKIP — out of scope** | n/a | Mem0 stays as fine-grained dialog facts (per discussion §9.4); not migrated |
| `matching-jobs.industryKey` (scraping) | type=`industry`, alias of canonical via `INDUSTRY_KEY_MAP` | seed canonicals only (Phase 1.7) | Don't backfill historical jobs — deterministic mapping in industry-tags.ts handles read path |

### 8.2 Backfill script design

Three scripts in `apps/functions/scripts/`:

```
backfill-pa-tags.mjs           # walks pa-users + pa-job-profiles
backfill-cv-skills.mjs         # walks pa-candidate-resumes
backfill-canonical-seed.mjs    # one-shot: writes seed canonical-tags from
                               #          INDUSTRY_TAGS + INDUSTRY_KEY_MAP +
                               #          AI_AGENT_SKILL_WEIGHTS + CATEGORY_RULES
```

Each script:
1. Paginate the source collection (1000 docs/page).
2. For each row, emit synthetic `pa-tag-events` with `source="manual-backfill"` and a stable per-source `sourceDocId`.
3. Worker picks them up and processes via Layer 1/2/3.
4. Throttle to 100 events/sec (avoids LLM rate-limit on Qwen-7B free tier).

Total volume estimate:
- 1k users × ~5 preferences avg = 5k events
- 1k users × ~15 CV skills avg = 15k events
- 40k matching-jobs × ~5 tags = 200k events (deferred — only emit on read miss in Phase 3.5)
- Researcher backfill: 100k researchers × ~3 venues/topics = 300k events (Phase 4)

**Idempotent**: re-running the script produces the same eventIds (sha256 deterministic) → no duplicates. Fail-safe.

---

## 9. Cross-repo coordination

### 9.1 Schema-change propagation

```
 wekruit-pa                                wekruit-scraping
 ├── packages/core-types/src/              ├── wekruit_shared_tags/
 │   canonical-tags.ts (Zod, AUTHORITY)        types.py (Pydantic, MIRRORS)
 │       ↓                                          ↑
 │   CI: scripts/emit-schema.mjs                    │ CI: schemathesis check
 │       ↓                                          │
 ├── packages/shared-tags/dist/canonical-tags.schema.json (artifact)
 │       ↓                                          │
 └── npm publish @wekruit/shared-tags ──────────────┘
        (version pinned in scraping repo's pyproject.toml as a dev-dep
         that runs the schemathesis check; Python types are hand-written
         but verified by CI to match.)
```

### 9.2 Versioning policy

- **Semver on `@wekruit/shared-tags`**:
  - **patch**: doc updates, internal refactor with no schema change
  - **minor**: new optional fields, new enum values (additive)
  - **major**: removed/renamed fields, enum value removed → breaking
- **Every event document carries `schemaVersion: "v1"`** field. Worker checks version on read; rejects unknown major versions.
- **Cross-repo migration playbook** for major bump:
  1. PA author updates schema, bumps to `v2.0.0`, publishes package.
  2. PA runs `dual-mode` worker: accepts both v1 + v2 events, normalizes to v2.
  3. Scraping repo PR upgrades, ships v2.
  4. Once all scraping pipelines are on v2, PA worker drops v1 acceptance.
  5. Existing v1 events in Firestore are migrated by a one-shot backfill script.

### 9.3 Rollback protection

If scraping ships a breaking schema change ahead of PA:
- **Wire safety**: `recordTagEvent()` validates `args` against the **pinned schemaVersion** at the package level. Mismatched version on either side → write fails locally.
- **Worker safety**: PA worker rejects events with `schemaVersion` it doesn't know — sets `status: "rejected", decision: "needs-review"` and alerts.
- **Audit**: schema-version mismatch metric in Cloud Monitoring; alert at >10 rejected/min.

### 9.4 Coordination process

- Schema changes proposed in PA `packages/core-types/` PR.
- **Required**: scraping repo PR opened **simultaneously** referencing the PA PR.
- Both PRs land in same week. CI on both repos runs the schemathesis test against the JSON Schema artifact.
- Slack channel `#tag-ontology` for cross-repo sync.

---

## 10. Test plan

### 10.1 Unit tests (per file)

| Test file | What it covers |
|---|---|
| `packages/shared-tags/__tests__/sha256.test.ts` | Idempotency key determinism: same args → same eventId across multiple invocations and across Node versions. |
| `packages/shared-tags/__tests__/record-tag-event.test.ts` | `.create()` race semantics: 2 concurrent calls with same args → 1 succeeds, 1 returns `{created: false, reason: "duplicate"}`. Validation error path. Truncation path. |
| `wekruit_shared_tags/tests/test_record_tag_event.py` | Python ↔ TS schema parity: same input args → byte-identical Firestore document (asserted via direct Firestore read). |
| `apps/functions/src/tag-worker/__tests__/normalize.test.ts` | Each layer hit path. Mutex collision path. Race: 2 workers commit different canonicals to same entity → only 1 entity-tag, count=1. |
| `apps/functions/src/tag-worker/__tests__/discovery.test.ts` | HDBSCAN against 100-tag synthetic fixture: 5 expected clusters → 5 promotions. False-positive guardrail (distinctness < 0.3 → skip). |
| `packages/pa-orchestrator/src/profile-loader.test.ts` | Decay correctness: stored confidence 1.0 + lastReinforced=180d ago → decayed = 0.5. Per-type half-life config. |

### 10.2 Integration tests

| Test | Steps |
|---|---|
| **End-to-end: scraping → PA read** | (1) `record_tag_event` from scraping repo Python with `entityRef={kind: "scraping-github-repo", id: "openai/swarm"}, type: "topic", rawText: "agent framework"`. (2) Wait 30s for worker. (3) PA reads via `getEntityTags("scraping-github-repo:openai/swarm")` → expect entry for canonical `agent-framework`. |
| **Cross-source attribution** | (1) PA event "ML" + scraping event "machine learning" + scraping-github "ML" — all for `pa-user:adam`. (2) Expect 1 entity-tag `machine-learning`, count=3, sources=[pa-realtime-tagger, scraping-job, scraping-github]. |
| **Mutual exclusion** | (1) Event "prefer ML" → entity-tag `machine-learning`, count=1. (2) Event "prefer machine learning" → SAME entity-tag, count=2 (mutex blocks duplicate canonical). (3) Event "preferences toward AI" — different mutexGroup → separate entity-tag. |
| **Idempotency** | (1) Same `(source, sourceDocId, rawText, entityRef)` 100 times → 1 event, 1 entity-tag, count=1. |

### 10.3 Load test (P2.13 ramp gate)

Synthetic load: 10,000 events/day pumped from a fixture for 7 consecutive days.
- Expect `tag_events_pending_age_p99 < 5 min` throughout.
- Expect zero events stuck in `pending` after 1 hour.
- Expect Qwen-7B free-tier rate-limit 0 429s (or graceful retry handling).
- Expect Firestore composite index `(type, aliases)` < 80% utilization (room for 100×-spike).

### 10.4 HDBSCAN discovery synthetic fixture

100-tag fixture: 5 known clusters + 20 noise points.
- Cluster A: 15 variants of "machine learning" (ML, machine learning, ml/ai, …)
- Cluster B: 12 variants of "Python"
- Cluster C: 8 variants of "RAG"
- Cluster D: 7 variants of "tool calling"
- Cluster E: 5 variants of "vector database"
- 20 noise points (random skills, no cluster ≥ 3)

Expected: 5 promotions. Promotion criteria coverage: A & B auto-approved; C & D operator-review; E operator-review (size 5 borderline).

### 10.5 Mutex false-positive coverage

Adversarial fixture: "data engineering" vs "data science" — embeddings cosine ~0.79. Expected: distinctness ≥ 0.3 → both promoted as separate canonicals; mutex groups distinct.

If LLM (Layer 2) wrongly merges them, Layer 3 cosine should catch (≥ 0.88 threshold not met). If both layers fail, operator catches via P4 review queue.

---

## 11. Risks (8+ specific)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Schema drift between PA + scraping**. Python-side hand-written types diverge from Zod. | High | CI schemathesis check against the JSON Schema artifact; PR-blocking. Monthly cross-repo audit. |
| R2 | **Worker idempotency breaks under retry storm**. Firestore at-least-once trigger fires 5× per event during outage; worker fails to detect double-process. | High | Strict status check `[a]` + `[g]` in tx; tx serializes status flip; idempotency tested at 100× concurrent in P2.10. |
| R3 | **Mutual-exclusion false-positive**: LLM merges "data engineering" + "data science" into one canonical → loses signal forever. | High | 3-layer cascade (LLM + cosine + operator); auto-promote only when distinctness ≥ 0.4; merge action in P4 reversible (audit-logged). |
| R4 | **Backfill rollback hard if discovery promotes wrong canonical**. 1000 events get stamped to wrong canonical, then operator merges away. | Medium | Backfill scripts re-runnable (idempotent eventId); P4.4 merge action moves entity-tags atomically; events keep `decision` field for re-processing. |
| R5 | **Qwen-7B free-tier rate limit kills Layer 2 mid-spike**. SiliconFlow may rate-limit at 60 RPM/account; 12% of 12k/day spike to 1k/min = >100 RPM. | Medium | Bucket worker concurrency at 10/instance × 50 instances = 500 concurrent — but LLM call is the throat. Mitigation 1: batched LLM (10 events/call). Mitigation 2: fall through to Layer 3 cosine on 429. Mitigation 3: queue overflow → tag-worker-retry (P2.9) backs off exponentially. |
| R6 | **Firestore vector search availability**: `findNearest` requires a vector index; not all regions support 1024-dim cosine on capped tier. | Medium | Pre-deploy: explicit index creation script in P2.5 + smoke test. Fallback: in-memory cosine over a 5k-canonical sample (still fast at PA scale). |
| R7 | **Cross-repo deploy desync** — scraping ships event with new field, PA worker dies. | Medium | Worker is **forward-compatible**: rejects unknown `schemaVersion` major bump cleanly via `status="rejected", decision="needs-review"`. Alert fires; operator pauses scraping until PA upgraded. |
| R8 | **Decay logic wrong for skills** — skills shouldn't decay but config might be misset. | Low | Per-type config in `DECAY_HALF_LIFE_BY_TYPE` (open question to Adam in §12). Test fixture asserts skill decay = 0. Operator can override per-tag via dashboard. |
| R9 | **English-only canonical loses Chinese signal**. Adam-locked but: realtime-tagger sees "湾区" → must be aliased to canonical `sf-bay-area`. If LLM normalize doesn't speak Chinese well, rejection rate spikes. | Medium | Qwen-7B is bilingual (zh+en); few-shot prompt includes 5 zh examples. Layer 3 BGE-M3 cosine is multilingual. Operator review catches escapes. |
| R10 | **Cost overrun**: PLAN.md sets $1.50/mo gate; real estimate $2.69/mo (§6). | Low (cost) / Medium (gating) | Surface to Adam in §12 open questions; recommend gate loosen to $5/mo. Real budget is operator time saved (~$200/mo if hand-curated) — ROI 70× even at $2.69. |
| R11 | **Firestore subcollection scan performance**: `loadUserProfile` scans `pa-entity-tags/{eK}/items` — degrades at 500+ tags. | Low | Cap subcollection size at 200; LRU evict by `lastReinforced` ascending. Top-K-per-type query for hot path. |
| R12 | **Operator-review queue depth blows up** during scraping ramp. Discovery proposes 100 canonicals/day, operator reviews 10/day → backlog. | Medium | Auto-promote tier (size ≥20, density ≥0.85) absorbs majority. Alert at queue depth > 50 for 24h (P4.6). |

---

## 12. Open questions for Adam

1. **Decay half-life per type**: I propose `preference: 180d`, `location: 365d`, `trait: 180d`, `topic: 365d`, all others = 0 (don't decay). Especially: **do skills decay?** — research interests in 2018 ML may not reflect 2026 LLM-engineering. Suggest: skill decay 730d (2-year half-life) — slow but non-zero. Confirm.
2. **Operator-review UI ownership**: dashboard `/canonical-tags-review` page is built by **WS2 P4** or by **WS8** (dashboard owner)? My plan assumes WS2 P4 (consistent with research doc). Confirm with WS8 engineer on shared admin shell.
3. **Dictionary seed scope**: I propose seeding from `INDUSTRY_TAGS` (10), `INDUSTRY_KEY_MAP` (~250 aliases), `AI_AGENT_SKILL_WEIGHTS` (30 rows), and scraping `CATEGORY_RULES` (12 buckets). Total ~300 canonicals at boot. Is that the right scope? Or also pull from `ROLE_TITLE_KEYWORDS` (20 patterns) for role canonicals?
4. **Python schema pinning mechanism**: I plan to publish `@wekruit/shared-tags` as a **public npm package** + scraping repo consumes via JSON Schema artifact (vendored). Alternative: PA repo private monorepo, scraping references via git submodule. Which does Adam prefer for cross-repo coordination overhead?
5. **Cost gate**: PLAN.md WS2 gate `≤ $1.50/mo`. My estimate $2.69/mo. Loosen to $5/mo? (Still 70× ROI.)
6. **Mutex collision UX**: when realtime-tagger writes "prefer ML" then later "prefer DL" (deep learning) — `mutexGroup` is per-canonical, so they coexist. But what if user says "我现在不想做 ML 了想做 DL"? Mutex only collapses *aliases*, not *contradictions*. For contradictions we need `negation` event type — proposed for iter31, out of scope here. Confirm OK to defer.
7. **Canonical naming convention**: kebab-case (`machine-learning`) per my schema. Research doc said snake_case (`machine_learning`). Existing `INDUSTRY_TAGS` is snake_case (`tech_software`). Pick one — I went with kebab to match URL/dashboard idioms. Confirm or revert.
8. **Layer 2 LLM batching**: at 1k/min spike, single-shot Qwen-7B is ~1k RPM. Free tier limit may cap at 60 RPM. Should we batch 10 events/call to stay under? Adds latency complexity. Confirm acceptable.

---

## 13. Calendar — week-by-week, 6-7 weeks

```
W1 (P1 sprint 1): schema + shared lib scaffolding
   Mon-Tue: P1.1, P1.2, P1.3, P1.4 (TS schema + record-tag-event)
   Wed:     P1.5 (CI emit-schema artifact)
   Thu-Fri: P1.6 (Python port + Pydantic types) — pair with scraping owner
   Weekend: deploy P1.1-P1.5 to PA staging

W2 (P1 sprint 2 + P2 kickoff):
   Mon:     P1.7 (seed canonical-tags from existing artifacts)
   Tue:     P1.8 (realtime-tagger dual-write)
   Wed:     P1.9 (cv-ingest emit)
   Thu-Fri: P1.10 (unit + integration tests), P1.11 (deploy + 24h verify)
   Friday gate: 1k events in pa-tag-events; no worker yet.

W3 (P2 sprint 1): worker Layer 1 + Layer 2
   Mon-Tue: P2.1 (skeleton + commit), P2.2 (Layer 1 hot lookup)
   Wed-Thu: P2.3, P2.4 (Qwen-7B Layer 2)
   Fri:     P2.6 (mutex enforcement), P2.7 (race handling), P2.8 (confidence)

W4 (P2 sprint 2): Layer 3 + retry + observability
   Mon-Tue: P2.5 (Layer 3 BGE-M3 + Firestore vector index)
   Wed:     P2.9 (retry queue), P2.11 (observability)
   Thu:     P2.10 (worker tests at scale)
   Fri:     P2.12 (1% ramp), 24h observe.
   ⏱ CRITICAL PATH: P2.5 + P2.6 must land before WS7 starts.

W5 (P2 ramp + P3 + WS7 sprint 1):
   Mon:     P2.13 ramp 10% → 100% over Mon-Wed; observe
   Mon-Tue: P3.1, P3.2, P3.3 (PA backfill scripts)
   Wed:     P3.4 (scraping github PR), P3.5 (devpost PR)
   Thu-Fri: WS7 starts: W7.1, W7.2 (profile-loader + types)
   Fri gate: 85% events normalized within 30s on real PA traffic.

W6 (P3 close + WS7 sprint 2):
   Mon:     P3.6 (researcher PR)
   Tue:     P3.7 (e2e cross-repo test)
   Wed:     W7.3 (RunContext integration — needs WS3 to have landed)
   Thu:     W7.4, W7.5 (decay logic)
   Fri:     W7.7 (reader migration in job-rec)

W7 (P4 + WS7 close):
   Mon-Tue: P4.1, P4.2 (HDBSCAN + promotion criteria)
   Wed:     P4.3 (operator review UI page)
   Thu:     P4.4 (merge action), P4.5 (auto-promote tier)
   Fri:     W7.8 (BoostCalculator integration), W7.9 (parity tests + acceptance gate close)
   Friday gate: all WS2 + WS7 acceptance gates green.
```

### 13.1 Critical path

```
P1.1 → P1.4 → P1.6 → P1.7 ─┐
                            ├─→ P2.1 → P2.4 → P2.5 → P2.6 ─┐
P1.10 (parity tests) ──────┘                                ├─→ P2.10 → P2.12
                                                            │       ↓
                                                            │     ramp
                                                            │       ↓
P3.1-P3.6 (parallel-able)  ◄──────────────────────────────  W4 ramp 100%
                                                                    ↓
                                                       W7.3 (after WS3 lands)
                                                                    ↓
                                                       W7.7 → W7.8 → P4.x
```

Hard dependency: **WS7 W7.3 blocks on WS3** (RunContext) landing in W4. If WS3 slips, WS7.3-W7.8 can be done with a stub `loadUserProfile()` direct-call site, deferring RunContext integration without unblocking the rest.

### 13.2 Unblock list for Adam

- **W2 end**: confirm decay half-life table (Q1) + cost gate (Q5) + canonical naming (Q7).
- **W3 start**: confirm operator-review UI ownership (Q2) + Python schema pinning (Q4).
- **W4 start**: confirm Q3 (dictionary seed scope) + Q8 (LLM batching).

If Adam is on vacation: I'll default to my proposals and flag in deploy report.

---

## 14. Deploy/verify discipline (CLAUDE.md iter23)

Per `/Users/adam/Desktop/WeKruit/wekruit-pa/CLAUDE.md` directive: each phase ends with a deploy + scenario verify. Specifically:

| Phase | Deploy command | Verify scenario |
|---|---|---|
| P1.11 | `cd apps/functions && pnpm run deploy` (cv-ingest + realtime-tagger) | scenario `tag-event-roundtrip.yaml` — write 1 event from PA + 1 from scraping; expect 2 docs in `pa-tag-events`. |
| P2.13 | functions deploy + Firestore vector index migration | scenario `worker-normalize-mutex.yaml` — 10-turn voice convo with 5 ML mentions across zh+en; expect 1 entity-tag `machine-learning`, count=5. |
| P3.9 | functions deploy + dashboard deploy (UserDetail panel) | scenario `dual-read-parity.yaml` — daily-batch on Adam's userId via old vs new path; expect identical job ranking. |
| P4.6 | dashboard deploy + scheduled function | scenario `discovery-fixture.yaml` — seed 100-tag fixture, run discovery, expect 5 promotions per §10.4. |

---

## 15. Confidence rating

**Confidence: 4/5 (high)**

Why high:
- Schema design grounded in research doc §3 + existing PA `industry-tags.ts` 250-alias pattern. Zero invention — extending what works.
- 3-layer cascade is industry-standard (LinkedIn skills graph blog, BERTopic, NeMo SemDedup). Worker logic ≤120 lines is trivial.
- Cost model **honest** — found a 3.1× discrepancy with research doc and surfaced it; my number reproducible from Firestore + Cloud Functions pricing pages.
- Cross-repo Option C (TS + Python port) is the lowest-magic, debuggable choice; both sides verifiable via JSON Schema parity test.
- WS7 profile-loader is a thin read API — straightforward.

Why not 5/5:
- **Firestore vector `findNearest` API behavior** at 1k canonical-tags + 100 RPM not battle-tested in this repo. P2.5 carries unknown — fallback is in-memory cosine which works at PA scale but doesn't generalize.
- **HDBSCAN promotion thresholds** (size ≥5, density ≥0.7, distinctness ≥0.3) are picked from research consensus; need P4 fixture validation before claiming "right".
- **Qwen-7B free-tier RPM limit** unknown to me. If it caps at 60 RPM, batching (Q8) becomes mandatory — adds 1d to P2.4.
- **Python ↔ TS sha256 byte-parity** sounds trivial but Python's hashlib + JSON canonicalization differs subtly from Node's crypto — needs 1 explicit parity test before P1 closes.

Risk-adjusted: WS2 ships in 5-6 weeks; WS7 closes in 7th week (1-week buffer absorbed if WS3 slips).

---

> [PUA生效 🔥] **闭环 sign-off**: 这份 plan 不是 design doc 是 **executable contract** — 每个 task ID 对应一个 ≤1d unit, 每个 acceptance gate 有 measurable signal。Adam 看完只要回答 §12 的 8 个 open question，工程师 day 1 就能开 P1.1。**不拉通就是补丁式开发**。这一份从 schema → worker → backfill → 跨仓 → operator UI 全 trace 通了 — 这才是 WS2/WS7 paired 该有的样子。
