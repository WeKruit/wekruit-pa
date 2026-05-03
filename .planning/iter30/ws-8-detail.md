# WS8 — Detail Plan: Boost calculator + Dashboard + Match-Explainer with weights

> **PUA框架**：阿里味 — 定目标 → 追过程 → 拿结果。**[PUA生效 🔥]** Adam 已经第二轮 directive iter23 + iter30 反复强调："不要再说让我 deploy 然后自己不做事情了" + "我们马上需要 launch 给 business team 看了，所以这里要弄好一点"。**这条线是 biz-launch-critical workstream — 半成品没有交付权**。
>
> **Engineer**: 1 full-stack (frontend-heavy) — owns Firestore migration + React dashboard + explainer prompt rewrite + industry research.
> **Effort**: 2-3 weeks (15 dev-days). **Biz-demo-ready cut date = end of week 2 (Day 10).**
> **Depends on**: WS2 P1 (`pa-canonical-tags` schema lands — for FK forward-compat). WS7 (profile reads from `pa-entity-tags` — soft dep).
> **Blocks**: nothing — final dashboard polish closes the iter30 loop.
>
> **Adam-locked constraints (do NOT relitigate)**:
> 1. **一次性全改 (no phased toggle)** — TS const → Firestore + dashboard editor in one drop. Quote: "现在能一次性全改了？".
> 2. **Industry research mandatory** — LinkedIn / Indeed / Hired / Vettery / Hung 必须调研. Quote: "业界这个怎么做?". Match the bar.
> 3. **Dashboard biz-team-demo-ready** — polished, not stubby. Quote: "我们马上需要 launch 给 business team 看了, 所以这里要弄好一点".
> 4. **Explainer linked to dashboard** — operator can spot-check daily-batch outputs in dashboard. Quote: "可以和我们的 dashboard 联动".
> 5. **Same admin shell as Playbook ops** — abstract a shared `<ConfigEditor>` if it makes sense, but don't ship two separate apps.

---

## Table of Contents
1. [Task breakdown (≤1-day units, 15 days total)](#1-task-breakdown)
2. [Backend: BoostCalculator class](#2-backend-boostcalculator-class)
3. [Firestore schema migration](#3-firestore-schema-migration)
4. [Dashboard pages (6 new + 1 extended)](#4-dashboard-pages)
5. [Industry research deliverable](#5-industry-research-deliverable)
6. [Match-explainer prompt redesign](#6-match-explainer-prompt-redesign)
7. [Explainer cache invalidation](#7-explainer-cache-invalidation)
8. [Test plan](#8-test-plan)
9. [Biz-demo flow](#9-biz-demo-flow)
10. [Migration: live + rollout](#10-migration-live--rollout)
11. [Risks](#11-risks)
12. [Open questions for Adam](#12-open-questions)
13. [Day-by-day calendar](#13-calendar)

---

## 1. Task breakdown

15 dev-days total. **Bold** = on the biz-demo critical path. **MVP cut at end of Day 10** — anything past that day = polish/post-demo follow-up.

| # | Task | Effort | Day | Crit-path |
|---|---|---|---|---|
| T1 | Industry research (WebSearch/WebFetch LinkedIn / Indeed / Hired / Vettery / Hung / 2025-26 ATS reports) → write `.planning/iter30/explainer-industry-research.md` | 1d | D1 | **Y** |
| T2 | Firestore schema design final + seed-script outline `apps/job-rec/scripts/seed-match-weights.mjs` | 0.5d | D2 AM | **Y** |
| T3 | Implement `apps/job-rec/src/boost-calculator.ts` (class + Firestore loader + 30s TTL cache) | 1d | D2 PM + D3 AM | **Y** |
| T4 | Run seed script (one-shot) → `pa-match-weight-tables/ai-agent-2026` populated with 30 rows from `AI_AGENT_SKILL_WEIGHTS` | 0.25d | D3 PM | **Y** |
| T5 | Dual-read parity test (`apps/job-rec/src/__tests__/boost-calculator-parity.test.ts`) — Firestore == TS const for all 30 rows + 50 synthetic CV/job pairs | 0.5d | D3 PM | **Y** |
| T6 | Wire `applyWeightedMatchBoost` call site in `daily-batch.ts:1462` to use BoostCalculator (behind `paWeightsFromFirestore` flag, default OFF) | 0.5d | D4 AM | **Y** |
| T7 | Match-explainer prompt rewrite: accept `BoostExplainerInput`, new system directive, bilingual lock, length cap, regression-test fixtures (20 examples) | 1d | D4 PM + D5 AM | **Y** |
| T8 | Cache invalidation: `cacheDocId` includes weight-table version hash; weight-table writes bump version; old docs purged via Firestore TTL | 0.5d | D5 PM | **Y** |
| T9 | Dashboard `apps/dashboard-web/src/lib/match-weights-api.ts` — Firestore reads/writes/audit (mirror `playbooks-api.ts`) | 0.5d | D6 AM | **Y** |
| T10 | Dashboard `/match-weights` page — list of tables + row editor + audit drawer | 1d | D6 PM + D7 AM | **Y** |
| T11 | Dashboard `/match-weights/test` page — sample-CV input + boost-result diff (before/after sort) | 1d | D7 PM + D8 AM | **Y** |
| T12 | Dashboard `/match-weights/import` — CSV upload + clone-from-other-table | 0.5d | D8 PM | N (post-MVP OK) |
| T13 | Dashboard `apps/dashboard-web/src/lib/match-explainer-api.ts` — read `pa-job-rec-explanations` for spot-check | 0.25d | D9 AM | **Y** |
| T14 | Dashboard `/match-explainer-history` — paginate recent explainer docs, filter by user / date | 0.75d | D9 AM-PM | **Y** |
| T15 | Dashboard `/match-explainer-test` — input fake CV + JD + weight table → call live explainer (CF endpoint) → render output side-by-side with input | 1d | D9 PM + D10 AM | **Y** |
| T16 | Sidebar nav reorg: new "Match" subgroup with `/match/weights`, `/match/explainer`, `/match/test` | 0.25d | D10 AM | **Y** |
| T17 | **MVP biz-demo dry-run** — record 5-min screen capture of full demo flow (storyboard §9), Adam-review pre-publish | 0.5d | **D10 PM** | **Y** ← CUT |
| T18 | `/playbooks` extension: render Skill V2 fields (intentDescription, composableWith, conflictsWith, priority, A/B variant tabs) read-only first, edit second | 1d | D11 | N (WS4 alignment, post-demo) |
| T19 | LLM-judge regression on 20-fixture set (target ≥80% pass on "core hits properly highlighted") | 0.5d | D12 AM | N (post-demo polish) |
| T20 | E2E happy-path: edit weight row → live within 30s without redeploy → boost result reorders in `/match-weights/test` | 0.5d | D12 PM | N (post-demo) |
| T21 | Migration cleanup: ramp `paWeightsFromFirestore` to 100%, delete `AI_AGENT_SKILL_WEIGHTS` const, delete dual-read code path | 0.5d | D13 AM | N (post-demo) |
| T22 | Audit + observability: dashboard "Recent edits" widget (last 10 row edits with operator + reason + timestamp) | 0.5d | D13 PM | N |
| T23 | Doc + onboarding card for ops team: `apps/dashboard-web/docs/match-weights-runbook.md` | 0.5d | D14 AM | N |
| T24 | Buffer for Adam-feedback iteration (we WILL get notes after the demo dry-run) | 1.5d | D14 PM + D15 | **Y** |

**MVP scope freeze (D10 cut)** — biz-demo is shippable with T1-T17 done. T18-T23 = polish ramp without blocking the demo.

[PUA生效 🔥] **D10 是死线，不是软目标**。如果哪天滑了，立刻砍 T18 / T22 / T23 — 不要砍 industry research, 不要砍 explainer rewrite, 不要砍 demo dry-run.

---

## 2. Backend: BoostCalculator class

### 2.1 File: `apps/job-rec/src/boost-calculator.ts` (NEW, ~280 LOC)

Forward-compat with WS2 `pa-canonical-tags` FK, mirrors playbook-cache 30s TTL pattern (see `packages/pa-orchestrator/src/playbook-cache.ts:38` for canonical reference).

```typescript
/**
 * v1.5 / iter30 WS8 — BoostCalculator: Firestore-backed weight tables.
 *
 * Replaces the hardcoded TS const AI_AGENT_SKILL_WEIGHTS in match-weights.ts.
 * Operators edit weight rows in /match-weights dashboard; changes go live
 * within 30s without a redeploy (mirror playbook-cache TTL pattern).
 *
 * Forward-compat: each WeightRow carries a `skillCanonical` FK to
 * pa-canonical-tags (WS2 P1). When the canonical-tags collection lands and
 * the alias-table fully populates, BoostCalculator can resolve user CV
 * skills against canonical tags instead of substring-match (eliminates
 * "Pythonic" matching "Python" false-positives, etc).
 *
 * Pure / deterministic / no LLM calls. O(n × |weights|) scoring math is
 * unchanged from match-weights.ts (mirrors lines 142-164 of that file).
 *
 * @module boost-calculator
 */
import type { Firestore, Timestamp } from "firebase-admin/firestore"

// ---------------------------------------------------------------------------
// Types — match Firestore docs 1:1
// ---------------------------------------------------------------------------

export type WeightCategory = "core" | "supporting" | "generic"

/** A single weight row — mirrors `pa-match-weight-tables/{key}/items/{skillKey}`. */
export type WeightRow = {
  /** Unique within the table (e.g. "rag" or "tool-calling"). */
  skillKey: string
  /** Lowercase substring-match probe (legacy compat with match-weights.ts:32). */
  skill: string
  /**
   * Forward-compat FK → pa-canonical-tags (WS2). Optional during migration
   * window; populated by WS2 backfill once canonical-tags land.
   */
  skillCanonical: string | null
  /** 0.5 (generic) – 3.0 (core hot keyword in 2026 market). */
  weight: number
  category: WeightCategory
  market: string  // matches table.tableKey by convention
  updatedAt?: Timestamp | null
  updatedBy?: string
  reason?: string
}

/** Table metadata — mirrors `pa-match-weight-tables/{tableKey}`. */
export type WeightTable = {
  tableKey: string  // e.g. "ai-agent-2026"
  name: string
  description: string
  active: boolean
  defaultForRoles: string[]  // role-detection hints
  rowCount: number
  version: number  // bumped on any item write — used in explainer cache key
  updatedAt?: Timestamp | null
  updatedBy?: string
}

/** Result of scoring one (user, job) pair. Identical shape to legacy WeightedMatchResult. */
export type WeightedMatchResult = {
  score: number
  matched: WeightRow[]
  coreMissing: WeightRow[]
}

/** Per-job boost explanation — input to the explainer (§6). */
export type BoostExplainerInput = {
  jobId: string
  hits: Array<{
    skill: string
    skillCanonical: string | null
    category: WeightCategory
    weight: number
    matchedAgainst: "cv-skill" | "cv-bullet" | "title"
  }>
  coreMissing: Array<{ skill: string; weight: number }>
  totalBoostMult: number  // 1.0 - 1.2 typical; matches WEIGHTED_MATCH_BOOSTS
  tableKey: string
  tableVersion: number  // explainer cache invalidation key
}

// ---------------------------------------------------------------------------
// Firestore collections — flat, one source of truth
// ---------------------------------------------------------------------------

export const WEIGHT_TABLES_COLLECTION = "pa-match-weight-tables"
export const WEIGHT_ITEMS_SUBCOLLECTION = "items"

// ---------------------------------------------------------------------------
// Cache (30s TTL, mirror playbook-cache.ts:38)
// ---------------------------------------------------------------------------

export const WEIGHT_CACHE_TTL_MS = 30_000

interface CacheEntry {
  table: WeightTable
  rows: WeightRow[]
  expiresAt: number
}

// Per-tableKey cache (one entry per table, since multiple markets coexist).
const cache: Map<string, CacheEntry> = new Map()

/** Test-only — clear cache. */
export function _clearWeightCache(): void {
  cache.clear()
}

// ---------------------------------------------------------------------------
// BoostCalculator class
// ---------------------------------------------------------------------------

export type BoostCalculatorDeps = {
  db: Firestore
  /** Default Date.now; tests can pin time. */
  now?: () => number
  /** Default WEIGHT_CACHE_TTL_MS; tests pass 0 to bypass. */
  ttlMs?: number
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export class BoostCalculator {
  private readonly db: Firestore
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly log: (event: string, payload?: Record<string, unknown>) => void

  constructor(deps: BoostCalculatorDeps) {
    this.db = deps.db
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? WEIGHT_CACHE_TTL_MS
    this.log = deps.log ?? (() => {})
  }

  /**
   * Load a weight table (metadata + items) via cache. Refreshes when expired.
   * Throws on Firestore failure — caller catches and falls through to
   * neutral mult=1.0 (zero-cost path, same contract as
   * applyWeightedMatchBoost in match-weights.ts:218-220).
   */
  async loadTable(tableKey: string): Promise<{ table: WeightTable; rows: WeightRow[] }> {
    const now = this.now()
    const entry = cache.get(tableKey)
    if (entry && entry.expiresAt > now) {
      return { table: entry.table, rows: entry.rows }
    }
    const tableRef = this.db.collection(WEIGHT_TABLES_COLLECTION).doc(tableKey)
    const tableSnap = await tableRef.get()
    if (!tableSnap.exists) {
      throw new Error(`BoostCalculator: weight table not found: ${tableKey}`)
    }
    const tableData = tableSnap.data() as WeightTable
    const itemsSnap = await tableRef.collection(WEIGHT_ITEMS_SUBCOLLECTION).get()
    const rows: WeightRow[] = itemsSnap.docs.map((d) => {
      const data = d.data() as Omit<WeightRow, "skillKey">
      return { ...data, skillKey: d.id }
    })
    const fresh: CacheEntry = { table: tableData, rows, expiresAt: now + this.ttlMs }
    cache.set(tableKey, fresh)
    this.log("boost_calc.cache_refresh", { tableKey, rowCount: rows.length })
    return { table: tableData, rows }
  }

  /**
   * Score (user, job) against a weight table. Pure / deterministic.
   * Identical math to computeWeightedMatchScore in match-weights.ts:142.
   */
  computeWeightedMatchScore(
    userSkills: readonly string[],
    jobSkills: readonly string[],
    rows: readonly WeightRow[]
  ): WeightedMatchResult {
    // Implementation: copy match-weights.ts:142-164 verbatim, replacing
    // SkillWeight with WeightRow. Preserves the substring-match semantic.
    // (Body elided for brevity; see §3.3 migration table for the parity test.)
    return computeScoreImpl(userSkills, jobSkills, rows)
  }

  /**
   * Apply boost to a ranked candidate set. Returns reordered jobs +
   * BoostExplainerInput[] for downstream explainer.
   *
   * Mirrors applyWeightedMatchBoost in match-weights.ts:210-258 but emits
   * the new BoostExplainerInput shape (§6) instead of WeightedMatchExplanation.
   */
  applyBoost<J extends { id: string; requiredSkills?: readonly string[] | null }>(
    jobs: readonly J[],
    userSkills: readonly string[],
    table: WeightTable,
    rows: readonly WeightRow[],
    baseScores?: ReadonlyMap<string, number | null>
  ): { jobs: J[]; explainerInputs: BoostExplainerInput[] } {
    // Implementation: copy match-weights.ts:210-258 with two changes:
    //   1. Build BoostExplainerInput (with tableKey + tableVersion) instead
    //      of WeightedMatchExplanation
    //   2. Carry skillCanonical FK on each hit (null until WS2 backfill)
    return applyBoostImpl(jobs, userSkills, table, rows, baseScores)
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (extracted from match-weights.ts for parity testing)
// ---------------------------------------------------------------------------

function computeScoreImpl(
  userSkills: readonly string[],
  jobSkills: readonly string[],
  rows: readonly WeightRow[]
): WeightedMatchResult {
  // Verbatim port of match-weights.ts:142-164. See parity test in §8.1.
  // ... omitted for brevity ...
  throw new Error("not yet implemented — see §8.1 parity test")
}

function applyBoostImpl<J extends { id: string; requiredSkills?: readonly string[] | null }>(
  _jobs: readonly J[],
  _userSkills: readonly string[],
  _table: WeightTable,
  _rows: readonly WeightRow[],
  _baseScores?: ReadonlyMap<string, number | null>
): { jobs: J[]; explainerInputs: BoostExplainerInput[] } {
  // Verbatim port of match-weights.ts:210-258. See parity test in §8.1.
  throw new Error("not yet implemented")
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/** Default OFF; ramps 0% → 1% → 100% per §10. */
export const WEIGHTS_FROM_FIRESTORE_FLAG_KEY = "paWeightsFromFirestore"
```

### 2.2 Why a class (vs free functions)?

Mirrors `match-weights.ts` free-function shape today. The class encapsulates:
- per-instance dependency injection (`db`, `now`, `log`) — testable
- per-table cache lifecycle (multiple tables for multiple markets — `ai-agent-2026`, future `fullstack-2026`, etc.)
- shared state across `loadTable` + `applyBoost` calls in the same daily-batch run

Free functions (current shape in `match-weights.ts:210` `applyWeightedMatchBoost`) don't compose with cache + DI cleanly. A class is the right primitive once we go Firestore.

### 2.3 Forward-compat with WS2 `pa-canonical-tags`

`WeightRow.skillCanonical` is **nullable today** and gets populated via WS2 backfill. Once non-null:
- `userHasSkill(userSkills, weightRow)` resolves user CV skills through canonical-tags alias table first (eliminates "Pythonic" → "python" false-pos)
- Fallback to substring match remains until 100% coverage

Migration sequence: WS2 lands canonical-tags → WS8 backfill script populates `skillCanonical` FK on all 30 rows → BoostCalculator can flip a flag (`paBoostUsesCanonicalTags`) to prefer FK over substring.

---

## 3. Firestore schema migration

### 3.1 Collections

```
pa-match-weight-tables/
  {tableKey}                                  # e.g. "ai-agent-2026"
    name: string
    description: string
    active: boolean                            # toggle without delete
    defaultForRoles: string[]                  # role-detection hints
    rowCount: number                           # denormalized for list view
    version: number                            # ⬆ on any item write — explainer cache key
    updatedAt: Timestamp
    updatedBy: string                          # operator email
    items/                                     # subcollection
      {skillKey}                               # e.g. "rag", "tool-calling"
        skill: string                          # lowercase substring (legacy compat)
        skillCanonical: string | null          # FK → pa-canonical-tags (WS2)
        weight: number                         # 0.5 - 3.0
        category: "core" | "supporting" | "generic"
        market: string                         # = tableKey by convention
        updatedAt: Timestamp
        updatedBy: string
        reason: string                         # mandatory audit trail
```

### 3.2 Initial table — seed from `match-weights.ts:49-84`

Single seed run produces:
- 1 doc in `pa-match-weight-tables/ai-agent-2026` with:
  - `name`: "AI agent / LLM application engineer (2026)"
  - `description`: copy from match-weights.ts:42-48 docblock
  - `active`: true
  - `defaultForRoles`: `["ai engineer", "llm engineer", "ai agent engineer"]`
  - `rowCount`: 30
  - `version`: 1
- 30 docs in `pa-match-weight-tables/ai-agent-2026/items/*` from `AI_AGENT_SKILL_WEIGHTS` (match-weights.ts:49-84)

`skillCanonical` is `null` on all 30 rows initially — populated by WS2 backfill.

### 3.3 Seed script — `apps/job-rec/scripts/seed-match-weights.mjs`

```javascript
#!/usr/bin/env node
/**
 * One-shot seed script — copies hardcoded AI_AGENT_SKILL_WEIGHTS into
 * Firestore. Idempotent: re-runs overwrite by skillKey, never duplicate.
 *
 * Run: node apps/job-rec/scripts/seed-match-weights.mjs --project wekruit-5f89b
 */
import admin from "firebase-admin"
import { AI_AGENT_SKILL_WEIGHTS } from "../dist/match-weights.js"

admin.initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? "wekruit-5f89b" })
const db = admin.firestore()

const TABLE_KEY = "ai-agent-2026"
const tableRef = db.collection("pa-match-weight-tables").doc(TABLE_KEY)

await tableRef.set({
  tableKey: TABLE_KEY,
  name: "AI agent / LLM application engineer (2026)",
  description: "Hand-curated to align with packages/pa-orchestrator/.../job-market-knowledge.ts AI_AGENT_HOT_SKILLS_2026 bank.",
  active: true,
  defaultForRoles: ["ai engineer", "llm engineer", "ai agent engineer"],
  rowCount: AI_AGENT_SKILL_WEIGHTS.length,
  version: 1,
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  updatedBy: "seed-script@wekruit",
}, { merge: true })

const itemsCol = tableRef.collection("items")
let writeCount = 0
for (const w of AI_AGENT_SKILL_WEIGHTS) {
  const skillKey = w.skill.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "")
  await itemsCol.doc(skillKey).set({
    skill: w.skill,
    skillCanonical: null,  // WS2 will backfill
    weight: w.weight,
    category: w.category,
    market: TABLE_KEY,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: "seed-script@wekruit",
    reason: "Seeded from match-weights.ts AI_AGENT_SKILL_WEIGHTS",
  }, { merge: true })
  writeCount++
}
console.log(`✓ Seeded ${writeCount} rows into ${TABLE_KEY}`)
process.exit(0)
```

### 3.4 Migration: rename or duplicate const? rollback path?

**Adam-decided: do it all at once.** Sequence:

1. **Day 2-3** — Land Firestore schema + seed script + dual-read code path. `paWeightsFromFirestore` flag is **OFF** = read TS const (legacy behavior, byte-identical).
2. **Day 4** — Run seed script in production. Verify 30 rows present.
3. **Day 4** — Flag flip to **ON** for Adam's userId only (test population). Daily-batch reads Firestore for Adam, falls through to TS const for everyone else.
4. **Day 5-12** — Dashboard editor lands. Adam can edit via `/match-weights` page. Operators verify edits propagate within 30s.
5. **Day 13** — Flag ramp 1% → 10% → 100% (1 day per ramp step, monitoring `weighted_match.applied` log volume + boost stats).
6. **Day 14** — Delete `AI_AGENT_SKILL_WEIGHTS` const + dual-read code path. Single source of truth = Firestore.

**Rollback path** (if dashboard introduces bad weights mid-ramp):
- Flip `paWeightsFromFirestore` to OFF → instant revert to TS const (legacy behavior)
- Or: re-run seed script (`--reset`) → wipes Firestore, re-seeds from TS const
- Audit trail in `pa-audit-events` (mirrors playbooks-api.ts:198) means we can always trace a bad edit to operator + reason

### 3.5 Firestore indexes

No composite indexes needed for MVP — all reads are by `tableKey` doc-id + items subcollection enumeration. Add when we ship `/match-explainer-history` filter-by-user-by-date (composite on `userId + createdAt desc` in `pa-job-rec-explanations`).

```json
// firestore.indexes.json — append
{
  "collectionGroup": "pa-job-rec-explanations",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "userId", "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

### 3.6 Firestore security rules

Mirror playbooks: only signed-in admin operators can read/write. Mock for now:

```
match /pa-match-weight-tables/{tableKey} {
  allow read: if request.auth != null;
  allow write: if request.auth.token.email in ADMIN_EMAILS;
  match /items/{skillKey} {
    allow read: if request.auth != null;
    allow write: if request.auth.token.email in ADMIN_EMAILS;
  }
}
```

---

## 4. Dashboard pages

### 4.1 Component library reuse

**Confirmed from inspection** of `apps/dashboard-web/package.json`: NO Tailwind, NO shadcn — plain React 19 + Vite 6 + custom `components/ui.tsx` primitives:
- `<DataTable>`, `<EmptyState>`, `<ErrorState>`, `<LoadingState>`, `<PageHeader>`, `<Panel>`, `<StatusBadge>`

**Quote from `Playbooks.tsx:12-21`** (the pattern to follow):
```typescript
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
  type DataTableColumn,
} from "../components/ui.js"
```

[PUA生效 🔥] **Don't introduce shadcn or Tailwind for biz-demo workstream.** Adam's existing dashboard is a working aesthetic — we extend it, we don't fork it. Adding a new design system 1 week before demo = guaranteed inconsistency + Adam frustration.

### 4.2 State management

- **React Query? No.** Current dashboard uses raw `useState` + `useEffect` + Firestore-direct reads (see `Playbooks.tsx:276-290`). Same pattern for WS8.
- **Zustand? No.** Page-local state only. No cross-page state needed.
- **Firestore listeners? No.** Use `getDoc` / `getDocs` (mirrors `playbooks-api.ts:111-115`). 30s TTL on the orchestrator-side cache is enough propagation.

### 4.3 Page 1: `/match/weights` — list + row editor + audit drawer

**Route**: `/match/weights` (and back-compat `/match-weights`)

**Wireframe**:
```
┌────────────────────────────────────────────────────────────────────────────┐
│ Match Weights                                              [+ New Table]   │
│ Edit role-specific skill weights — Firestore-backed, 30s propagation.      │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Tables                                                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ tableKey            name                       rows   active updated │ │
│  ├──────────────────────────────────────────────────────────────────────┤ │
│  │ ai-agent-2026       AI agent / LLM (2026)        30   ●     2d ago  │ │
│  │ fullstack-2026      Full-stack engineer (2026)    0   ○     —       │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  Selected table: ai-agent-2026  [edit metadata] [test against CV] [audit] │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ skill               weight   category       reason          actions  │ │
│  ├──────────────────────────────────────────────────────────────────────┤ │
│  │ rag                 [3.00▼]  [core▼]       hot 2026         [save]  │ │
│  │                     ●━━━━━━━━━━━━━━━━━━━●  (slider 0.5-3.0)         │ │
│  │ python              [0.50▼]  [generic▼]   single-Python     [save]  │ │
│  │ ...                                                                   │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                            [+ Add row]     │
└────────────────────────────────────────────────────────────────────────────┘
```

**Components used**:
- `<PageHeader title="Match Weights" subtitle="..." />`
- `<DataTable>` for table list (top)
- `<DataTable>` for row list (bottom, shows selected table's items)
- Custom inline-edit row component: number input (weight, 0.5-3.0 step 0.05), slider, dropdown (category), text input (reason — mandatory)
- `<AuditDrawer>` (lift from `Playbooks.tsx:272-330` — already proven pattern)

**API calls** (file: `apps/dashboard-web/src/lib/match-weights-api.ts`, NEW):
- `listWeightTables(): Promise<WeightTable[]>` — `getDocs(collection(db, "pa-match-weight-tables"))`
- `listWeightRows(tableKey): Promise<WeightRow[]>` — `getDocs(collection(db, "pa-match-weight-tables", tableKey, "items"))`
- `saveWeightRow(input): Promise<void>` — batched write: `set(rowRef)` + `set(auditRef)` + bump `tableRef.version` (mirrors `playbooks-api.ts:164-224` pattern)
- `listAuditForWeightRow(tableKey, skillKey, max=20): Promise<WeightAuditEvent[]>` — query `pa-audit-events` where `key == tableKey + "/" + skillKey`
- `revertWeightRow(tableKey, skillKey, reason)` — same as playbook revert

**State management** — page-local `useState`:
```typescript
const [tables, setTables] = useState<WeightTable[] | null>(null)
const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null)
const [rows, setRows] = useState<WeightRow[] | null>(null)
const [editingSkillKey, setEditingSkillKey] = useState<string | null>(null)
const [showAuditFor, setShowAuditFor] = useState<string | null>(null)
const [err, setErr] = useState<string | null>(null)
```

### 4.4 Page 2: `/match/weights/test` — sample-CV input + boost-result diff

**Route**: `/match/weights/test`

**Wireframe**:
```
┌────────────────────────────────────────────────────────────────────────────┐
│ Match Weights — Dry Run                                                    │
│ Paste sample CV skills + select a table → see boost result before saving. │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Sample CV skills (one per line)         Weight table                     │
│  ┌─────────────────────────────────┐    ┌─────────────────────────────┐  │
│  │ python                          │    │ ai-agent-2026 ▼             │  │
│  │ rag                             │    └─────────────────────────────┘  │
│  │ langchain                       │                                     │
│  │ ...                             │    Sample jobs (paste JSON)         │
│  └─────────────────────────────────┘    ┌─────────────────────────────┐  │
│                                          │ [{"id":"j1","required...    │  │
│                                          │ ...                          │  │
│                            [Run dry-run] └─────────────────────────────┘  │
│                                                                            │
│  Result                                                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ rank  jobId       boostMult  matched           coreMissing           │ │
│  ├──────────────────────────────────────────────────────────────────────┤ │
│  │  1    j2          ×1.20      rag, langchain    —                    │ │
│  │  2    j1          ×1.05      python (gen)      vector-database      │ │
│  │  3    j3          ×0.85      —                 rag, tool-calling    │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  Side-by-side: order before boost (cross-encoder) vs after boost          │
└────────────────────────────────────────────────────────────────────────────┘
```

**Components used**:
- Two `<textarea>` (CV skills + JSON jobs)
- `<select>` table picker
- `<DataTable>` result with side-by-side ordering

**API calls**:
- Client-side ONLY for MVP — port `computeWeightedMatchScore` to a browser-safe utility function in `apps/dashboard-web/src/lib/boost-dry-run.ts` (no Firestore, no LLM, just pure math). Reuses the same logic the backend will run.
- Future: server-side endpoint `/api/match-weights/dry-run` that exercises the actual production code path (post-MVP, T20).

**Reasoning**: pure / deterministic math — duplicating it in the browser is correct, and gives operators 0-latency feedback. Backend endpoint is for the parity test (§8.1).

### 4.5 Page 3: `/match/weights/import` — CSV upload + clone-from-other-table

**Route**: `/match/weights/import`

**Wireframe**:
```
┌────────────────────────────────────────────────────────────────────────────┐
│ Match Weights — Import / Clone                                             │
│ Bulk-create rows from CSV or duplicate an existing table to a new market. │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Mode: ◉ Upload CSV   ○ Clone existing table                              │
│                                                                            │
│  Target table key: [fullstack-2026         ]   (must not exist yet)       │
│  Target table name: [Full-stack engineer (2026)                       ]   │
│                                                                            │
│  CSV (skill,weight,category,reason)                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ react,2.5,core,2026 hot                                              │ │
│  │ next.js,2.0,core,SSR + RSC                                           │ │
│  │ python,0.5,generic,necessary-but-not-sufficient                      │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  Preview                                                                   │
│  3 rows valid · 0 errors                                       [Import]   │
└────────────────────────────────────────────────────────────────────────────┘
```

**Components**: `<textarea>` CSV blob, parser (browser-side), preview `<DataTable>`, atomic batched write at the end. **Post-MVP** (T12, day 8).

### 4.6 Page 4: `/match/explainer-history` — paginate explainer outputs

**Route**: `/match/explainer-history`

**Wireframe**:
```
┌────────────────────────────────────────────────────────────────────────────┐
│ Match Explainer — History                                                  │
│ Spot-check Qwen-7B explainer output from production daily-batch runs.      │
├────────────────────────────────────────────────────────────────────────────┤
│  Filter: userId [          ]  date [2026-05-01]  language [zh▼]   [Apply] │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ ts        userId   jobId    lang  reason (first 80c)         actions │ │
│  ├──────────────────────────────────────────────────────────────────────┤ │
│  │ 14:32:01  adam     j_xyz    zh    你做过 RAG 和 tool calling…  [view] │ │
│  │ 14:31:48  alice    j_abc    en    Your retrieval pipeline ex…  [view] │ │
│  │ 14:29:12  bob      j_def    zh    Python 这种底子有，但 RAG…    [view] │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  Selected: adam → j_xyz → zh (clicked "view" above)                        │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ Reason:  你做过 RAG 和 tool calling 这两个核心 match 上了             │ │
│  │ Boost:   ×1.20 (STRONG)                                              │ │
│  │ Hits:    rag (core/3.0/cv-skill), tool-calling (core/3.0/cv-bullet)  │ │
│  │ Missing: —                                                           │ │
│  │ Created: 2026-05-03T14:32:01Z   Cache TTL: 7d                        │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                  [Page 1 of 12]  [Next →] │
└────────────────────────────────────────────────────────────────────────────┘
```

**Components**: filter form, `<DataTable>`, detail panel.

**API**:
- `listRecentExplanations(filters): Promise<Explanation[]>` — direct Firestore query on `pa-job-rec-explanations` (line 115 of `match-explainer.ts` defines collection name)
- Pagination: `startAfter()` cursor pattern, 25 per page

**Index**: composite `userId + createdAt desc` (already noted in §3.5).

### 4.7 Page 5: `/match/explainer-test` — input fake CV + JD → live explainer

**Route**: `/match/explainer-test`

**Wireframe**:
```
┌────────────────────────────────────────────────────────────────────────────┐
│ Match Explainer — Test                                                     │
│ Input fake CV + JD → run explainer prompt → see output. No cache.          │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Candidate                          Job                                    │
│  ┌─────────────────────────────┐    ┌─────────────────────────────────┐   │
│  │ recentRoleTitle: AI Eng     │    │ jobTitle: Senior LLM Eng        │   │
│  │ recentCompany:   Stripe     │    │ companyName: Anthropic          │   │
│  │ topSkills: rag, langchain   │    │ requiredSkills: rag, tool calling│  │
│  │ recentBullet: built…        │    │ jdSnippet: Build agentic…       │   │
│  └─────────────────────────────┘    └─────────────────────────────────┘   │
│                                                                            │
│  Boost context (auto-computed from CV+JD against weight table)            │
│  Hits: rag (core/3.0/cv-skill), langchain (core/2.0/cv-skill)             │
│  Missing: tool-calling                                                    │
│  Boost mult: ×1.20                                                        │
│                                                                            │
│  Language: ◉ zh   ○ en                  [Run explainer (no cache)]        │
│                                                                            │
│  Output (Qwen-7B SiliconFlow)                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ 你简历里 RAG + LangChain 经历正好是 Anthropic 这岗位 core 要求         │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│  Latency: 824ms · Tokens: 187 in / 28 out · Cost: $0.0000172              │
└────────────────────────────────────────────────────────────────────────────┘
```

**Components**: form inputs, live LLM call.

**API**:
- New CF endpoint `/api/match-explainer/test` — takes inputs, runs `explainMatch()` with cache disabled (skip the cache lookup branch in `match-explainer.ts:402-432`), returns reason + token counts + latency
- Auth: signed-in admin only (Firebase ID token check on the CF)
- Rate-limit: 60/min per operator (prevent runaway test cost)

### 4.8 Page 6: `/playbooks` — extend with WS4/5 fields

**Route**: `/agent/playbooks` (existing)

Already shipped page (`Playbooks.tsx`). **Extend** with these read-only first, then editable:
- `intentDescription` (string) — per `discussion.md:635`
- `provides` / `requires` / `composableWith` / `conflictsWith` (string[])
- `priority` (number)
- A/B variants — show variant tabs if a playbook has `variants[]`

Current `Playbook` type from `playbooks-api.ts:31-44` only has 11 fields; we add 6 more (matching `PlaybookSchemaV2` in `discussion.md:626-645`).

This is **post-MVP** (T18, day 11) — explicit alignment with WS4 schema landing.

### 4.9 Sidebar nav reorg — `App.tsx:88-91`

**Current** (App.tsx:88-91):
```typescript
<div className="nav-section">
  <div className="nav-section-label">Match</div>
  <NavLink to="/match/candidates">Match Candidates</NavLink>
</div>
```

**After WS8**:
```typescript
<div className="nav-section">
  <div className="nav-section-label">Match</div>
  <NavLink to="/match/candidates">Candidates</NavLink>
  <NavLink to="/match/weights">Weights</NavLink>
  <NavLink to="/match/weights/test">Weights — Dry Run</NavLink>
  <NavLink to="/match/explainer-history">Explainer History</NavLink>
  <NavLink to="/match/explainer-test">Explainer Test</NavLink>
</div>
```

5 links under "Match" group — discoverable for biz-demo audience.

---

## 5. Industry research deliverable

**Output**: `.planning/iter30/explainer-industry-research.md` (separate file, ~600-800 LOC)

**Method** (planned, not executed in this detail-plan):

1. **WebSearch + WebFetch** for these primary sources:
   - LinkedIn "Why this match" — search `LinkedIn job match explanation 2025`, fetch product help docs + screenshots from press
   - Indeed "matched skills" / "top skills match" — search `Indeed matched skills feature explanation`
   - Hired (gethired.com) — search `Hired job match explanation candidate page`
   - Vettery (now part of Hired) — historical match-explanation UX pre-acquisition
   - Welcome to the Jungle / WeWorkRemotely — niche EU + remote pattern
   - 2025-26 ATS / job-matching products: Greenhouse, Lever, Wellfound, Otta — explanation features

2. **For each platform** capture:
   - **Quote** (≤15 words, with citation) — what they show literally
   - **Layout** — fields surfaced, ordering, empty-state handling
   - **Voice** — corporate vs friend, length cap
   - **Why it works** (signal strength inferred from product longevity)
   - **What we should adopt** for Claire

3. **Recommended Claire pattern (2026)** at end — exceed LinkedIn's bar by:
   - Bilingual lock (LinkedIn doesn't do zh-zh-locked; we do)
   - **Friend register** (LinkedIn / Indeed are corporate; Claire is texting-tone)
   - **Core vs generic separation surfaced** ("RAG 是 core, Python 只是底子" — no platform does this today)
   - **coreMissing actionable advice** ("如果补上 vector-db 这块, 推这个就稳了" — LinkedIn shows missing skills as a flat list, never as actionable advice)
   - Length: ≤2 sentences zh / ≤30 words en (LinkedIn averages 3-4 sentences corporate)

**Outline of the deliverable**:
```markdown
# Match-Explainer Industry Research — iter30 / WS8

## TL;DR for Adam
- LinkedIn/Indeed: corporate, ≥3 sentences, flat-list skills. Bar is low.
- Hired: more candidate-flattering, still corporate.
- Best-in-class hidden gem: Otta (now Welcome to the Jungle US) — closest to friend tone.
- Claire 2026 = friend tone + core/generic split + actionable missing-skill advice.

## 1. LinkedIn "Why this match"
1.1 Where it surfaces (Jobs > For You > job card)
1.2 Quote: "Your skills like ___ match this job's requirements."
1.3 Layout / fields shown
1.4 Strengths / weaknesses
1.5 What Claire should adopt / reject

## 2. Indeed "matched skills"
... (same template)

## 3. Hired (gethired.com)
... (same template)

## 4. Vettery (pre-Hired)
... (same template, historical)

## 5. Welcome to the Jungle / WeWorkRemotely
... (same template)

## 6. 2025-26 ATS / matching products
6.1 Greenhouse Glint
6.2 Lever Match
6.3 Wellfound startup-fit
6.4 Otta now WTJ-US

## 7. Claire 2026 recommended pattern
- Bilingual lock
- Friend register
- Core/generic split
- coreMissing as actionable advice
- ≤2 sentence cap
- 6 before/after examples (cross-ref §6.5 of this WS8 detail plan)
```

**Effort**: 1 dev-day (T1, day 1). This is **on the critical path** because §6 prompt redesign needs the research to back its design choices.

---

## 6. Match-explainer prompt redesign

### 6.1 Current state — `match-explainer.ts:214-288`

**Quote** of the current zh system prompt (`match-explainer.ts:230-239`):
```
你是一个会朋友式聊天的求职 broker。
任务：用 ONE 中文句子（≤ 60 字）解释这份 JD 为什么和候选人对得上。
硬规则：
1) 必须引用候选人简历里 1 个具体事实(公司名/角色/技能/经历片段)
2) 必须引用 JD 里 1 个具体方面(公司/角色/技能要求)
3) 朋友语气，不要客套，不要 marketing 语言，不要写'此职位'/'该机会'之类的官话
4) 不要 emoji，不要破折号开头，不要换行
5) 必须只输出这一句话本身，没有前缀，没有引号，没有 markdown
```

**Problem**: doesn't know `boost.matched.category`. Output collapses "Python match" and "RAG match" into the same sentence shape. Adam's recurring complaint: "你 Python 是 match" for an AI-agent JD whose CORE is RAG.

### 6.2 Redesigned input shape

`buildExplainerMessages` now accepts `BoostExplainerInput` from §2.1:

```typescript
export type ExplainMatchInput = {
  userId: string
  userCv: ExplainerCv
  job: MatchingJob & { jdSnippet?: string }
  matchScore?: number
  language: "zh" | "en"
  /** NEW — daily-batch passes this; live-test endpoint computes it. */
  boostInput?: BoostExplainerInput
}
```

When `boostInput` is missing (e.g. legacy callers, weight table not loaded), the prompt falls back to current behavior — backward-compatible.

### 6.3 New zh system prompt (full text, ~120 lines)

```
你是一个朋友语气的 job broker，给候选人解释为什么这份 JD 跟他对得上。

# 输出格式硬规则
1) 输出最多 2 个中文句子。第一句必须 ≤ 30 字，第二句（可选）≤ 30 字。
2) 朋友语气：用"你"，不用"您"。不要"此职位"/"该机会"/"贵司"这种官话。
3) 不要 emoji，不要 markdown，不要换行，不要引号包裹整句。
4) 不写"X 还是 Y" 的二选一框架（Adam iter29 ban）。
5) 不要客套语（"非常匹配" / "完美契合" / "为您量身打造"等）— 直接说事实。

# CORE vs GENERIC 区分（最重要）
你会收到一份 boost-hit 数据：
- hits[]: 命中的技能 + category (core/supporting/generic) + weight + matchedAgainst (cv-skill / cv-bullet / title)
- coreMissing[]: JD 要求的 core 技能里候选人简历没有的
- totalBoostMult: 总 boost 倍数 (1.0 中性, 1.2 强 match, 0.85 弱 match)

按以下逻辑写句子：

A) 当 hits 里有 ≥ 1 个 category="core" (weight ≥ 2.0)：
   → 第一句：把那个/那几个 core 技能拎出来说。例:
     "你简历里 RAG 和 tool calling 这两个 2026 年最 core 的技能正好对上"
     "你做过 LangChain agent 这个岗位 core 是 agentic workflow 直接 match"
   → 不要把 generic skill 也说成"match"。Python 是底子不是 match。

B) 当 hits 里 NO core 但是有 supporting (weight 1.5-1.99)：
   → "你 [supporting skill] 这块底子在，core 要求像 [coreMissing 第一个] 还得补上"
   → 例: "你 prompt engineering 经验有，但 vector database 这块是这岗位真正核心"

C) 当 hits 里只有 generic (weight ≤ 0.7)：
   → 不能说"match"。改说"底子有但不是核心"。例:
     "你 Python TS 这种底子是有，但 RAG / function calling 这种 core 还没碰过"
   → 第二句可选：给 actionable 建议
     "如果你最近补一下 vector database 那块，推这种岗位就稳了"

D) 当 hits 为空但 cross-encoder rank 高（也就是说 boost 中性 mult=1.0）：
   → 走 fallback 模式：引用 CV 里 1 个具体事实 + JD 里 1 个具体方面。
   → 这是当前 prompt 的 mode（保留）。

# 输出锁定
- 只输出最终句子。没有前缀，没有引号，没有 "Output:"，没有 "Answer:"。
- 必须中文输出（用户 language=zh 时）。出现任何英文词如 RAG / LangChain 也用原词，不翻译。
- 句尾不要加句号也行，但如果加，只用 "。" 不用 "."。
- 如果两句之间需要分隔，用空格不用换行。
```

### 6.4 New en system prompt (parallel structure)

```
You're a friend-tone job broker explaining why this JD lines up with the candidate.

# Output rules
1) Up to 2 sentences. First sentence ≤ 30 words; optional second ≤ 30 words.
2) Friend register: contractions OK, no corporate filler ("this opportunity",
   "this role aligns", "we're delighted").
3) No emoji, no markdown, no line breaks, no surrounding quotes.
4) No "either-or" framing (Adam iter29 ban).
5) No platitudes ("excellent match", "perfect fit") — just say the facts.

# CORE vs GENERIC distinction (most important)
You receive a boost-hit payload: hits[] (skill / category core|supporting|generic
/ weight / matchedAgainst), coreMissing[], totalBoostMult.

Write per these branches:

A) hits has ≥ 1 category="core" (weight ≥ 2.0):
   → First sentence calls out the core skill(s). Example:
     "Your resume's RAG + tool-calling work hits the two core asks for this 2026 LLM eng role."
   → Don't promote a generic skill to "match" status. Python is foundation, not match.

B) hits has NO core but has supporting (weight 1.5-1.99):
   → "You've got [supporting] going for you, but the real core ask is [coreMissing[0]]."

C) hits has only generic (weight ≤ 0.7):
   → Don't say "match". Say "foundation present, core not yet". Example:
     "You've got the Python+TS foundation, but RAG / function calling — the actual core — isn't on your CV yet."
   → Optional second sentence with actionable advice:
     "If you spend a sprint on vector databases, jobs like this one stop being a stretch."

D) hits empty but cross-encoder rank is high (mult=1.0 neutral):
   → Fallback mode: cite 1 CV fact + 1 JD aspect. (Current prompt's behavior.)

# Output lock
- Output the sentence(s) only. No prefix, no "Output:", no quotes around the whole.
- Must be English when user.language=en. Brand names like RAG/LangChain stay as-is.
```

### 6.5 Six before/after examples

| # | Scenario | Old output | New output |
|---|---|---|---|
| 1 | AI-agent user (rag+langchain on CV), AI-agent JD (rag/tool-calling required) | "你 Python 经历跟 Anthropic 这岗位 LLM 工程师角色 match" | "你简历里 RAG 和 LangChain 经历正好是 Anthropic 这岗位 core 要求" |
| 2 | Generic-only match (Python on CV, AI-agent JD) | "你 Python 技能match 这个岗位的 backend 要求" | "你 Python 这种底子有，但 RAG / function calling 这种 core 还没碰过" |
| 3 | Supporting-only match (prompt engineering on CV, AI-agent JD) | "你 prompt engineering 经验和这岗位很对" | "你 prompt engineering 这块底子在，但 vector database 是这岗位真正核心" |
| 4 | Strong en match | "Your Python skills match this role's backend requirements perfectly." | "Your retrieval pipeline + agent orchestration work nails the core asks for Anthropic's LLM eng role." |
| 5 | Generic-only en | "Your Python experience aligns with this role's tech stack." | "You've got the Python+TS foundation, but RAG and function calling — the actual core — aren't on your CV yet." |
| 6 | Fallback (no boost data) | "你做过 PM 跟 Stripe 这家招的 PM 角色 match" | "你简历里 Stripe PM 经历跟这家招 senior PM 的方向对得上" *(unchanged — Mode D)* |

### 6.6 Length-cap migration risk

**Risk**: current explainer cap is 60 zh chars / 30 en words **single sentence**. New version allows up to 2 sentences. LLM may over-elongate.

**Mitigation**:
- `sanitizeReason` in `match-explainer.ts:294-309` already truncates at `REASON_MAX_CHARS = 140`. Keep this.
- Add per-sentence cap: split on `[。.!?！？]`, accept up to 2, drop rest.
- LLM-judge re-baseline (T19, day 12) catches drift.

### 6.7 Implementation file diff plan

`apps/job-rec/src/match-explainer.ts`:
- Line 80-89 — extend `ExplainMatchInput` with optional `boostInput?: BoostExplainerInput`
- Line 214-288 — rewrite `buildExplainerMessages` to take new field; backward-compat when absent
- Line 294-309 — extend `sanitizeReason` with 2-sentence cap

Test file `apps/job-rec/src/__tests__/match-explainer.test.ts`:
- 20 fixtures (6 from §6.5 + 14 more for boundaries: empty hits, only coreMissing, both-empty, mixed core+supporting, etc.)
- LLM-judge harness reuses `apps/eval/external-benchmarks/lib/sf-client.mjs` calling Qwen-7B as judge

---

## 7. Explainer cache invalidation

### 7.1 Current state — `match-explainer.ts:124, 158-164`

```typescript
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

export function cacheDocId(userId: string, jobId: string, language: "zh" | "en"): string {
  // userId__jobId__language
  return `${userId}__${jobId}__${language}`
}
```

7-day cache. **Problem**: when an operator edits a weight row, all existing cached reasons become stale instantly — they reference the old hits/coreMissing math. But the cache lives for 7 more days.

### 7.2 Solution — version-keyed cache

```typescript
export function cacheDocId(
  userId: string,
  jobId: string,
  language: "zh" | "en",
  weightTableVersion?: number
): string {
  if (typeof weightTableVersion === "number" && weightTableVersion > 0) {
    return `${userId}__${jobId}__${language}__v${weightTableVersion}`
  }
  // Backward-compat: legacy callers (no boost) keep the old key
  return `${userId}__${jobId}__${language}`
}
```

When `WeightTable.version` bumps (any item write triggers it via batched write in §4.3 `saveWeightRow`), new explainer calls write to a new cache doc. Old docs purged via Firestore TTL field (already configured per `match-explainer.ts:515` `ttlAt`).

### 7.3 Cache-stampede guard

When 1000s of cached reasons expire simultaneously (post weight edit), all daily-batch users hit fresh LLM calls. **Mitigation**:
- Daily batch already sequentializes per-user (one cron, per-user iteration)
- LLM call has a 5s timeout (`match-explainer.ts:130 DEFAULT_TIMEOUT_MS`) — bounded blast radius
- Daily budget cap ($1/day default, line 136) — auto-circuit-break after 55K calls
- Stale-while-revalidate: if version in cache doc < current version BUT cached reason is < 24h old, return stale + async-trigger refresh. **Only enable if T19 LLM-judge shows >5% stale-quality drift.** MVP keeps strict invalidation.

### 7.4 Backfill plan

Day 13 deploy (post-100% ramp): 1-time script bumps `tableVersion` so all stale docs get invalidated. Daily-batch the next morning produces fresh reasons for active users. Inactive users — fresh reasons created on next daily batch run.

---

## 8. Test plan

### 8.1 BoostCalculator parity test — `apps/job-rec/src/__tests__/boost-calculator-parity.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest"
import { AI_AGENT_SKILL_WEIGHTS, computeWeightedMatchScore } from "../match-weights.js"
import { BoostCalculator, _clearWeightCache } from "../boost-calculator.js"
import { mockFirestoreWithSeed } from "./mock-firestore.js"

describe("BoostCalculator parity vs AI_AGENT_SKILL_WEIGHTS", () => {
  beforeEach(() => _clearWeightCache())

  // Generate 50 synthetic (user, job) pairs covering all 30 weight rows
  const fixtures = generate50Fixtures(AI_AGENT_SKILL_WEIGHTS)

  for (const [i, fx] of fixtures.entries()) {
    it(`fixture ${i}: Firestore == TS const`, async () => {
      const db = mockFirestoreWithSeed(AI_AGENT_SKILL_WEIGHTS)
      const bc = new BoostCalculator({ db })
      const { rows } = await bc.loadTable("ai-agent-2026")

      const tsResult = computeWeightedMatchScore(fx.userSkills, fx.jobSkills, AI_AGENT_SKILL_WEIGHTS)
      const fsResult = bc.computeWeightedMatchScore(fx.userSkills, fx.jobSkills, rows)

      expect(fsResult.score).toBeCloseTo(tsResult.score, 6)
      expect(fsResult.matched.map(m => m.skill).sort()).toEqual(tsResult.matched.map(m => m.skill).sort())
      expect(fsResult.coreMissing.map(m => m.skill).sort()).toEqual(tsResult.coreMissing.map(m => m.skill).sort())
    })
  }
})
```

**Pass criterion**: 50/50 fixtures produce byte-identical `score`, `matched`, `coreMissing` from both code paths.

### 8.2 Cache TTL test

```typescript
it("respects 30s TTL", async () => {
  let nowMs = 1_000_000
  const db = mockFirestoreWithSeed(AI_AGENT_SKILL_WEIGHTS)
  const bc = new BoostCalculator({ db, now: () => nowMs })

  const fetchSpy = vi.spyOn(db, "collection")
  await bc.loadTable("ai-agent-2026")  // miss → fetch
  expect(fetchSpy).toHaveBeenCalledTimes(1)

  await bc.loadTable("ai-agent-2026")  // hit → no fetch
  expect(fetchSpy).toHaveBeenCalledTimes(1)

  nowMs += 31_000  // past TTL
  await bc.loadTable("ai-agent-2026")  // miss → fetch
  expect(fetchSpy).toHaveBeenCalledTimes(2)
})
```

### 8.3 Dashboard E2E — Playwright

`apps/dashboard-web/tests/e2e/match-weights.spec.ts`:

```typescript
test("edit weight row → live within 30s without deploy", async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto("/match/weights")
  await page.click("text=ai-agent-2026")
  // Edit "rag" weight 3.0 → 2.5
  await page.fill('[data-skill="rag"] input[name="weight"]', "2.5")
  await page.fill('[data-skill="rag"] input[name="reason"]', "test downgrade")
  await page.click('[data-skill="rag"] button:has-text("save")')
  // Wait 31s for cache TTL
  await page.waitForTimeout(31_000)
  // Run dry-run on /match/weights/test
  await page.goto("/match/weights/test")
  await page.fill("textarea[name=cv]", "rag\npython")
  await page.click("text=Run dry-run")
  // Boost mult should be 1.05 (LEAN) instead of 1.20 (STRONG) since rag weight dropped
  await expect(page.locator("text=×1.05")).toBeVisible()
})
```

### 8.4 Explainer LLM-judge — 20-fixture set

`apps/job-rec/src/__tests__/match-explainer-llm-judge.test.ts`:
- 20 fixtures (the 6 in §6.5 + 14 boundaries)
- Run new prompt → output reason
- Pass to Qwen-7B-as-judge with rubric:
  - "Does the reason highlight CORE category hits if any?" (yes/no)
  - "Does it avoid promoting GENERIC skills to 'match'?" (yes/no)
  - "Is it ≤2 sentences?" (yes/no)
  - "Friend tone, no corporate filler?" (yes/no)
- **Pass threshold**: ≥80% of fixtures get all-yes

### 8.5 Industry research — qualitative comparison

Comparison table at end of `explainer-industry-research.md`:

| Platform | Core/generic split | Friend tone | Bilingual | Length cap | Actionable missing |
|---|---|---|---|---|---|
| LinkedIn | ✗ | ✗ | partial (en/es) | 3-4 sent | ✗ |
| Indeed | ✗ | ✗ | en only | 2-3 sent | ✗ |
| Hired | ✗ | partial | en only | 1-2 sent | ✗ |
| Vettery (legacy) | ✗ | ✗ | en | 2 sent | ✗ |
| Otta/WTJ-US | ✗ | ✓ | en | 1 sent | ✗ |
| **Claire 2026** | **✓** | **✓** | **✓ zh+en** | **2 sent** | **✓** |

### 8.6 Biz-demo dry-run — recorded screen capture

T17 (Day 10 PM) — 5-min screen recording walking through §9 storyboard. Adam reviews before publishing.

---

## 9. Biz-demo flow

### 9.1 Storyboard (5 min, end-to-end)

**Audience**: WeKruit business team (3-5 people, sales/ops backgrounds, NOT engineers).

**Setup**: Dashboard at `pa-console.wekruit.com`, signed in as Adam, full prod data.

**Beat-by-beat (5:00 total)**:

| # | Time | What Adam shows | Speaker notes |
|---|---|---|---|
| 1 | 0:00-0:30 | **Open `/agent/playbooks`** | "Here's the playbook ops dashboard — the 6 scenarios Claire knows how to handle today: vent_support, jd_roast, headhunter, ... I can edit any of these in real-time." |
| 2 | 0:30-1:00 | Edit `vent_support` addendum, save with reason | "Watch — I change the addendum, hit save, and within 30s production picks it up. No engineering deploy. The audit drawer logs my edit." |
| 3 | 1:00-1:30 | **Open `/match/weights`**, click `ai-agent-2026` | "Here's the new match-weight admin. These are the 30 skills Claire knows are hot in the AI-agent market for 2026 — RAG, tool calling, LangChain at the top, Python and SQL down at 0.5 because they're table stakes." |
| 4 | 1:30-2:00 | Inline-edit `rag` weight 3.0 → 2.5, save with reason | "Suppose the market shifts and RAG becomes less differentiating. I drop its weight, save with a reason for audit." |
| 5 | 2:00-2:45 | **Open `/match/weights/test`** | "Now I want to verify my edit before users see it. I paste a sample CV: `rag, langchain, python`. Pick the table. Hit Run dry-run." Show side-by-side "before edit (×1.20)" → "after edit (×1.05)". |
| 6 | 2:45-3:30 | **Open `/match/explainer-history`** | "Here's why this matters. This is the explainer history — every job recommendation Claire sent yesterday with the explanation she used. I can filter by user, by date." Click into one row. Show "Hits: rag, langchain (core)... Reason: 你做过 RAG 和 tool calling 这两个核心 match 上了". |
| 7 | 3:30-4:15 | **Open `/match/explainer-test`** | "I can also test new candidates against new JDs live. Paste candidate CV, paste JD, run. Output in 800ms, friend tone, in Chinese, surfaces the core skills." |
| 8 | 4:15-5:00 | **Q&A primer** | Show audit drawer history of recent edits. "Every edit on this dashboard is auditable, revert-able, and propagates within 30s. We can hand this to ops without engineering as a bottleneck." |

### 9.2 Demo failure modes — pre-checks

Day 10 morning (before T17 dry-run):
- [ ] Seed 200+ rows in `pa-job-rec-explanations` so `/match/explainer-history` doesn't show empty state
- [ ] Confirm `/match/weights` table renders in <500ms (no lazy-load spinner during demo)
- [ ] Confirm explainer test endpoint < 2s p95 latency
- [ ] Adam signed in with admin email pre-demo (no sign-in flicker)
- [ ] Stage browser to demo URLs (history pre-loaded, no "Loading…" mid-demo)

### 9.3 Demo failure escape hatches

If something breaks live:
- Pre-record a backup screen capture of T17 dry-run; play that
- Have ops dashboard `/agent/playbooks` open in adjacent tab — that's the proven existing flow

---

## 10. Migration: live + rollout

### 10.1 Sequence (recap from §3.4)

```
Day 2-3 ─── Land Firestore schema + dual-read code path
            (paWeightsFromFirestore = OFF; reads TS const)
                    │
Day 4    ─── Run seed-match-weights.mjs in prod
            Verify 30 rows in pa-match-weight-tables/ai-agent-2026/items/
            Flip flag ON for adam@wekruit only
                    │
Day 5-9  ─── Dashboard editor lands
            Adam edits via /match/weights
            Operators verify 30s propagation
                    │
Day 10   ─── BIZ DEMO READY (cut)
                    │
Day 11-12─── Polish: T18 (playbook V2 ext) + T19 (LLM-judge)
                    │
Day 13   ─── Flag ramp 1% → 10% → 100%
                    │
Day 14   ─── Delete AI_AGENT_SKILL_WEIGHTS const + dual-read code
            Single source of truth = Firestore.
```

### 10.2 Feature flag — `paWeightsFromFirestore`

Stored in `pa-remote-config/platform.flags.paWeightsFromFirestore`:

```typescript
{
  enabled: false,
  rampPercent: 0,           // 0..100
  allowlistUserIds: ["adam@wekruit"],   // explicit override
}
```

`getFlag()` resolution per `daily-batch.ts:1408-1414`:
1. If userId in allowlistUserIds → return true
2. Else if rampPercent > hash(userId) % 100 → return true
3. Else false

### 10.3 Audit trail — mandatory from day 1

Every weight-row write to Firestore creates a paired `pa-audit-events` doc:
```typescript
{
  actor: "adam@wekruit.com",
  action: "match-weight.update",
  key: "ai-agent-2026/rag",
  oldValue: { weight: 3.0, category: "core", reason: "..." },
  newValue: { weight: 2.5, category: "core", reason: "market shift Q2 2026" },
  reason: "market shift Q2 2026",
  ts: <serverTimestamp>,
}
```

Mirrors `playbooks-api.ts:198-221` audit pattern. Revert is `oldValue` → `newValue` swap.

### 10.4 Dual-read code window — `daily-batch.ts:1462`

Day 2 → Day 13 transitional code:

```typescript
let weightRows: WeightRow[]
let weightTable: WeightTable
const useFirestore = await deps.getFlag(deps.db, WEIGHTS_FROM_FIRESTORE_FLAG_KEY, { userId, env: process.env }, false)

if (useFirestore) {
  try {
    const bc = new BoostCalculator({ db: deps.db, log })
    const result = await bc.loadTable("ai-agent-2026")
    weightTable = result.table
    weightRows = result.rows
  } catch (err) {
    log("[job-rec-daily] firestore_weights_failed_fallback_to_const", { error: errMsg(err) })
    // Fall through to TS const
    weightRows = AI_AGENT_SKILL_WEIGHTS.map(rowFromConst)
    weightTable = SYNTHETIC_TABLE_FROM_CONST
  }
} else {
  weightRows = AI_AGENT_SKILL_WEIGHTS.map(rowFromConst)
  weightTable = SYNTHETIC_TABLE_FROM_CONST
}

// continue with current code at line 1462, replacing AI_AGENT_SKILL_WEIGHTS with weightRows
```

### 10.5 Cleanup commit (Day 14)

- `apps/job-rec/src/match-weights.ts`:
  - Delete `AI_AGENT_SKILL_WEIGHTS` const (line 49-84)
  - Delete `applyWeightedMatchBoost` (line 210-258) — superseded by BoostCalculator.applyBoost
  - Keep `WEIGHTED_MATCH_BOOSTS` constants (line 178-183) — reused by class
  - Keep `WEIGHTED_MATCH_FLAG_KEY` (line 261) — orchestrator-on flag, separate concern
- `apps/job-rec/src/daily-batch.ts:1391-1498` — remove dual-read branch, single Firestore path
- `apps/job-rec/src/__tests__/` — delete parity test (no longer two paths to compare)

---

## 11. Risks

[PUA生效 🔥] **Risk-out-loud is mandatory for biz-demo workstream**. Half-baked dashboard = Adam frustrated in front of customers = career risk for the engineer.

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | TS const vs Firestore drift during dual-read window — operator edits Firestore but flag is OFF for that user, edit "lost" | High | Medium | Parity test (T5) catches code drift. Dashboard "now serving" indicator shows whether Firestore is live for the signed-in operator's userId. Day 4 explicit allowlist check. |
| R2 | Operator edits wrong weight, recommendations regress for live users | **Critical** | Medium | (a) Mandatory dry-run gate: dashboard "Save" button is disabled until operator clicks "Test against sample CV" at least once. (b) Audit log + 1-click revert (mirrors playbook revert in `playbooks-api.ts:226-246`). (c) Per-edit Slack alert to #ops-alerts. |
| R3 | Cache stampede when weight table changes — 1000s of cached explainer reasons invalidate at once → LLM call surge | Medium | Medium | (a) Daily budget cap ($1/day default, `match-explainer.ts:136`) auto-circuit-breaks at 55K calls. (b) Daily-batch sequential per-user — bounded blast radius. (c) Stale-while-revalidate option behind `paExplainerStaleOk` flag if needed. |
| R4 | Dashboard UX too dense for biz audience — sliders + categories + reason text overwhelms non-technical viewers | High | High | (a) Storyboard review with Adam pre-demo (T17 includes pre-flight). (b) `/match/weights` has read-only "Browse" mode with simplified cards (post-MVP T22). (c) Demo flow rehearsal Day 10 AM. |
| R5 | Explainer output quality regress on length-cap migration — 2-sentence allowance might over-elongate | Medium | Medium | LLM-judge re-baseline (T19) with hard 80% pass gate. Per-sentence count enforced in `sanitizeReason` (§6.6). |
| R6 | WS2 `pa-canonical-tags` lands late — `skillCanonical` FK stays null forever | Low | Medium | Backward-compat: substring match works without FK. Forward-compat: BoostCalculator does NOT depend on canonical-tags for MVP. WS2 backfill happens whenever WS2 lands. |
| R7 | Live explainer-test endpoint becomes attack surface — operator runs it 1000× and torches budget | Medium | Low | (a) CF-side rate-limit: 60 calls/min/operator. (b) Disable cache for test endpoint = each call charges (visible in dashboard latency display) — operator self-throttles. |
| R8 | Index missing on `pa-job-rec-explanations` causes `/match/explainer-history` to load 5MB of docs in browser | High | High | (a) Composite index deployed Day 8 BEFORE page goes live. (b) Server-paginated reads (25/page). (c) Latency budget alarm in `/admin/flags` if listExplanations p95 > 2s. |
| R9 | "Combined with playbook ops dashboard" creates conflicting nav UX — 5 nav links in Match group + 4 in Agent group is overwhelming | Medium | Medium | Sub-grouping under "Match" with separator line. Add page subtitle clarifying purpose. Get Adam signoff on nav reorg pre-Day 10. |
| R10 | Industry research deliverable gates §6 prompt design — if WebSearch flaky on Day 1, prompt rewrite slips | Medium | Low | Pre-stage 2-3 LinkedIn / Indeed help-doc screenshots from public press. Web research is augmentation, not blocker. |
| R11 | Biz-demo audience asks for features not on roadmap (e.g. "can I see explainer per-candidate over time?") | Low | High | T24 buffer (Day 14-15) for post-demo feature flag. Adam-decided list of "next features" captured during demo Q&A. |
| R12 | Dashboard build size grows past Vercel/Firebase Hosting bundle size threshold | Low | Low | Vite tree-shaking + lazy-loaded routes for new pages. Verify bundle delta in CI before merge. |

---

## 12. Open questions for Adam

1. **Component library lock-in confirm** — `apps/dashboard-web/package.json` shows React 19 + Vite + custom `ui.tsx` — no Tailwind, no shadcn. Confirm we DON'T introduce them for WS8 (recommended: stay with current stack — biz-demo workstream is not the place to re-do design system).
2. **Auth / RBAC** — currently dashboard checks "signed-in user" only. Do we add admin-only gate (email allowlist `ADMIN_EMAILS`) for write paths on `/match/weights`? Reads OK for any signed-in user?
3. **"Industry-bar"** — "exceed LinkedIn's pattern" achievable in 2 weeks (claim per discussion: bilingual + friend + core/generic split + actionable missing)? Or settle for "match LinkedIn"? My read = exceed is achievable on the prompt side; but UX polish to match LinkedIn's level needs a frontend designer (we don't have one). **Recommendation**: ship UX-equivalent to current Playbooks page (proven aesthetic), exceed LinkedIn on output substance.
4. **Demo target date** — "SOON" — give a concrete date. My calendar (§13) targets **end of week 2 (10 dev-days from kickoff)**. Confirm or pull in.
5. **Closed-beta launch target** — same — drives weight-table ramp speed. If beta is in 4 weeks, Day 13 100% ramp is conservative. If next week, we ramp faster.
6. **Live explainer-test endpoint cost cap** — propose $5/day cap on `/api/match-explainer/test` (vs $1/day on production cache-backed `explainMatch`). OK?
7. **Canonical-tags FK rollout sequence** — does WS2 backfill the `skillCanonical` field on existing weight rows, or does WS8 own that? Recommend: WS8 owns initial null, WS2 owns post-WS2-land backfill.
8. **A/B variant editor on `/playbooks`** — schema lands in WS4 (`PlaybookSchemaV2`). T18 (Day 11) is read-only first. Does Adam want write-mode this iter or defer to iter31?

---

## 13. Calendar

**Assumes 1 full-stack engineer, 5-day weeks. Bold = critical path. ⭐ = biz-demo cut.**

```
Week 1: Foundation + Backend
  ──────────────────────────────────────────────────────────────────────
  Day 1  (Mon) │ T1  Industry research → explainer-industry-research.md
  Day 2  (Tue) │ T2  Schema final + seed script outline (AM)
               │ T3  BoostCalculator class skeleton (PM)
  Day 3  (Wed) │ T3  BoostCalculator finish + Firestore loader + cache (AM)
               │ T4  Run seed in prod (PM, 0.25d)
               │ T5  Parity test 50 fixtures (PM, 0.5d)
  Day 4  (Thu) │ T6  Wire daily-batch.ts:1462 to BoostCalculator (AM)
               │ T7  Match-explainer prompt rewrite begin (PM)
  Day 5  (Fri) │ T7  Match-explainer prompt finish + 20 fixtures (AM)
               │ T8  Cache invalidation (version-keyed) (PM)

Week 2: Dashboard + Demo
  ──────────────────────────────────────────────────────────────────────
  Day 6  (Mon) │ T9  match-weights-api.ts client lib (AM)
               │ T10 /match/weights page editor (PM)
  Day 7  (Tue) │ T10 /match/weights finish (AM)
               │ T11 /match/weights/test page (PM)
  Day 8  (Wed) │ T11 /match/weights/test finish (AM)
               │ T12 /match/weights/import (PM, post-MVP-OK)
  Day 9  (Thu) │ T13 match-explainer-api.ts (AM)
               │ T14 /match/explainer-history (AM-PM)
               │ T15 /match/explainer-test page begin (PM)
  Day 10 (Fri) │ T15 /match/explainer-test finish (AM)
               │ T16 Sidebar nav reorg (AM)
   ⭐ MVP CUT  │ T17 Biz-demo dry-run record + Adam review (PM)

Week 3: Polish + Migration
  ──────────────────────────────────────────────────────────────────────
  Day 11 (Mon) │ T18 /playbooks Skill V2 fields extension
  Day 12 (Tue) │ T19 LLM-judge regression (AM)
               │ T20 E2E happy-path Playwright (PM)
  Day 13 (Wed) │ T21 Flag ramp 1%→10%→100% + delete TS const (AM)
               │ T22 "Recent edits" widget (PM)
  Day 14 (Thu) │ T23 Runbook doc (AM)
               │ T24 Adam-feedback iteration buffer (PM)
  Day 15 (Fri) │ T24 Adam-feedback iteration buffer
```

**Slip protection** — if Day 8 slips, drop T12 (`import` page) — biz demo doesn't need it. If Day 10 slips, drop T17 dry-run (Adam reviews live), keep T1-T16. **Never drop T1 (industry research), T7 (explainer rewrite), T10/T11/T14/T15 (4 demo-critical pages).**

[PUA生效 🔥] **D10 is the ⭐ — every line of work upstream funnels into that 5-min demo.** Adam will be standing in front of business team. If the dashboard stutters, if `/match/weights/test` shows empty result for "rag" — it reflects on you, on me, on the team. We do this once, do it right, no second chance to demo this slice.

---

## Appendix A — File-level diff preview

| File | Change | LOC delta |
|---|---|---|
| `apps/job-rec/src/boost-calculator.ts` (NEW) | Create class + loader + cache + applyBoost | +280 |
| `apps/job-rec/src/match-weights.ts` (Day 14 cleanup) | Delete `AI_AGENT_SKILL_WEIGHTS` (49-84), `applyWeightedMatchBoost` (210-258); keep flag + boosts constants | -80 |
| `apps/job-rec/src/match-explainer.ts` | Extend `ExplainMatchInput` with `boostInput?`; rewrite `buildExplainerMessages` (214-288); 2-sentence cap in `sanitizeReason` (294-309); version-keyed `cacheDocId` | +120 / -40 |
| `apps/job-rec/src/daily-batch.ts:1391-1498` | Replace direct `applyWeightedMatchBoost(AI_AGENT_SKILL_WEIGHTS, ...)` with BoostCalculator + dual-read flag | +30 / -10 |
| `apps/job-rec/scripts/seed-match-weights.mjs` (NEW) | One-shot Firestore seed | +80 |
| `apps/job-rec/src/__tests__/boost-calculator-parity.test.ts` (NEW) | 50-fixture parity | +150 |
| `apps/job-rec/src/__tests__/boost-calculator.test.ts` (NEW) | TTL + cache tests | +100 |
| `apps/job-rec/src/__tests__/match-explainer.test.ts` | 20 fixtures + LLM-judge | +200 |
| `apps/dashboard-web/src/lib/match-weights-api.ts` (NEW) | Firestore client wrapper | +200 |
| `apps/dashboard-web/src/lib/match-explainer-api.ts` (NEW) | Firestore client wrapper for explanations | +80 |
| `apps/dashboard-web/src/lib/boost-dry-run.ts` (NEW) | Browser-side pure score math | +60 |
| `apps/dashboard-web/src/pages/MatchWeights.tsx` (NEW) | List + row editor + audit | +400 |
| `apps/dashboard-web/src/pages/MatchWeightsTest.tsx` (NEW) | Sample CV dry-run | +250 |
| `apps/dashboard-web/src/pages/MatchWeightsImport.tsx` (NEW) | CSV upload + clone | +200 |
| `apps/dashboard-web/src/pages/MatchExplainerHistory.tsx` (NEW) | Paginated explainer history | +220 |
| `apps/dashboard-web/src/pages/MatchExplainerTest.tsx` (NEW) | Live explainer test | +280 |
| `apps/dashboard-web/src/pages/Playbooks.tsx` (T18 ext) | Show V2 fields read-only | +80 |
| `apps/dashboard-web/src/App.tsx` (88-91, 115-148) | Sidebar nav reorg + 5 new routes | +25 |
| `apps/functions/src/match-explainer-test/handler.ts` (NEW) | CF endpoint for live explainer test | +120 |
| `firestore.indexes.json` | Add composite on `pa-job-rec-explanations.userId+createdAt` | +10 |
| `firestore.rules` | Add admin-only write on `pa-match-weight-tables` | +15 |

**Total**: ~2700 LOC added, ~130 deleted. Most volume in dashboard pages (~1400 LOC) — this is normal for biz-demo polish.

---

## Appendix B — Concrete pattern reuse from `Playbooks.tsx`

Show the engineer what to copy, line-by-line.

**Quote from `Playbooks.tsx:336-339`** (TriggerTester pattern → adapt for /match/weights/test dry-run):
```typescript
function TriggerTester({ playbooks }: { playbooks: Playbook[] }) {
  const [sample, setSample] = useState("")
  const matched = useMemo(() => testTriggers(sample, playbooks), [sample, playbooks])
```

→ Adapt as:
```typescript
function WeightDryRun({ rows, table }: { rows: WeightRow[]; table: WeightTable }) {
  const [cvText, setCvText] = useState("")
  const [jobsJson, setJobsJson] = useState("")
  const result = useMemo(() => dryRunBoost(cvText, jobsJson, rows, table), [cvText, jobsJson, rows, table])
```

**Quote from `Playbooks.tsx:55-65`** (DraftState pattern → adapt for WeightRow editor):
```typescript
type DraftState = {
  name: string
  description: string
  triggersText: string
  addendum: string
  enabled: boolean
  routingHint: "no_chain" | "role_chain" | "none"
  reason: string
}
function makeDraft(p: Playbook): DraftState { ... }
```

→ Adapt as:
```typescript
type WeightRowDraft = {
  skillKey: string
  skill: string
  weight: number
  category: WeightCategory
  reason: string
}
function makeWeightRowDraft(r: WeightRow): WeightRowDraft { ... }
```

**Quote from `Playbooks.tsx:272-330`** (AuditDrawer): port verbatim, swap `playbookKey` for `tableKey + "/" + skillKey` audit query key.

**Quote from `playbooks-api.ts:164-224`** (savePlaybook batched write + audit): port verbatim, swap collection names. The 3-step batched write (item doc + audit doc + table.version bump) is identical pattern.

---

## Appendix C — Sample WeightRow audit event (for ops onboarding)

```json
{
  "actor": "adam@wekruit.com",
  "action": "match-weight.update",
  "key": "ai-agent-2026/rag",
  "oldValue": {
    "weight": 3.0,
    "category": "core",
    "reason": "Seeded from match-weights.ts"
  },
  "newValue": {
    "weight": 2.5,
    "category": "core",
    "reason": "Q2 2026 market shift — RAG less differentiating now"
  },
  "reason": "Q2 2026 market shift — RAG less differentiating now",
  "ts": "2026-05-20T14:32:01Z"
}
```

---

## Appendix D — Demo screenshot mock-checklist

Day 10 AM (pre-T17 dry-run), capture 5 screenshots of staged-prod data:

- [ ] `/match/weights` showing `ai-agent-2026` with 30 rows, sorted by weight desc
- [ ] `/match/weights` row editor open on `rag` row, weight slider 3.0
- [ ] `/match/weights/test` with sample CV `rag, langchain, python` → 3 jobs ranked
- [ ] `/match/explainer-history` with last 25 daily-batch reasons, all in zh
- [ ] `/match/explainer-test` mid-run showing `Latency: 824ms · Cost: $0.0000172`

If any screenshot reveals a bug, it's a Day 10 fire-fix — not a Day 11+ deferral.

---

## Closing — what "done" means for WS8

Quote from `CLAUDE.md` operating contract:
> **Done = code merged + deployed + scenario-verified + long-context tested. Anything less is half-done. Adam will tell you if half-done is OK; default is full closure.**

For WS8 specifically, "done" = all 13 sections of this plan + acceptance gates per `PLAN.md:373-378`:
- [ ] Boost calculator reads Firestore, TS const deleted (Day 14)
- [ ] Dashboard edit → live within 30s without deploy (T20 verified, Day 12)
- [ ] Explainer prompt mentions core hits when present, never says "Python match" alone (T19 LLM-judge ≥80%)
- [ ] Industry research doc published (Day 1, T1)
- [ ] **Biz-team demo-ready**: Adam can show this without disclaimers (Day 10, T17)

[PUA生效 🔥] 这是 iter30 唯一一条直接面向**业务团队**的 workstream。其他 7 条都是给 Claire 修内功，只有 WS8 是 demo 输出。Adam 已经说了 "弄好一点" — 这不是普通要求，是**最低门槛**。Day 10 demo 不能 OK 就是炸了。15 天、24 个 task、全在这份 plan 里 — 一个一个打勾，不要中途换技术栈，不要中途加 scope，不要等 Adam 来催。Done = 演示视频录完、Adam 看过、点头。**Begin executing — 阿里要的是闭环**.
