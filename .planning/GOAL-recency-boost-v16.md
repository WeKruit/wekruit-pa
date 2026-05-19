# GOAL — V16 recency boost (today's jobs win)

**Owner:** Adam
**Status:** EXECUTING (Adam locked B_max=0.10, τ=3d, exp decay — 2026-05-19)
**Created:** 2026-05-19

---

## Why

Adam directive (2026-05-19):

> "also job match should also prefer latest recent jobs.. like today's new
> parsed & matched jobs"

Audit of `apps/job-rec/src/tools/query-matching-jobs-v16.ts`:

| Layer | Recency? |
|---|---|
| Query (`orderBy firstSeenAt desc` + top-500) | ✅ |
| Hard filter (`firstSeenAt < 20d` adaptive 20→45→90) | ✅ |
| **Soft score** (`V16_SCORE_WEIGHTS` 6 components) | ❌ **no recency** |
| Additive boost (`positiveHit 0.15` + `urgencyBoost 0.20`) | ⚠️ urgency only fires when `urgentlySeeking===true` |
| Sort | tiebreak only |

**Gap:** default user (most users — `urgentlySeeking !== true`) gets ZERO
freshness signal at score time. Today's job and 19-day-old job tied on
skill+industry can flip order based on sub-decimal LLM noise.

---

## Fix — additive freshness boost (default ON, exponential decay)

Mirror existing `urgencyBoost` shape. Do NOT redistribute
`V16_SCORE_WEIGHTS` (closed sum 1.0 is calibrated).

**Decay shape:** exponential half-life (industry standard — LinkedIn / Indeed /
RecSys baseline). Adam 2026-05-19: B_max=0.10, τ=3d.

### Constants (new — `query-matching-jobs-v16.ts:~738`)

```ts
// Phase B5 — default-on freshness boost. Applies to ALL users (urgency
// boost already covers urgentlySeeking=true with larger magnitude).
// Exponential half-life decay: boost = B_max * 0.5^(age / τ)
// Adam 2026-05-19: B_max=0.10, τ=3d → today=0.100, 3d=0.050, 7d=0.020,
// 14d=0.004, 20d=0.001. Naturally floors near 0 by hard-filter edge.
export const V16_FRESHNESS_BOOST_MAX = 0.10
export const V16_FRESHNESS_HALF_LIFE_MS = 3 * 24 * 3600 * 1000  // τ = 3 days
```

### Score integration (`query-matching-jobs-v16.ts:~820`)

Add **before** `const total = baseScore + tagOverlapScore + positiveHitBoost + urgencyBoost`:

```ts
let freshnessBoost = 0
const firstSeenForBoost = timestampToMs(job.firstSeenAt)
if (firstSeenForBoost > 0) {
  const nowForBoost = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now()
  const ageMs = Math.max(0, nowForBoost - firstSeenForBoost)
  freshnessBoost = V16_FRESHNESS_BOOST_MAX * Math.pow(0.5, ageMs / V16_FRESHNESS_HALF_LIFE_MS)
}
const total = baseScore + tagOverlapScore + positiveHitBoost + urgencyBoost + freshnessBoost
```

Add `freshnessBoost` to `breakdown` return + the `V16ScoreBreakdown` type.

### Magnitude rationale

| Boost | Max value | Why |
|---|---|---|
| `urgencyBoost` (existing) | 0.20 | Strongest — explicitly opted in |
| `positiveHit` (existing) | 0.15 | Curated company allow-list |
| `freshnessBoost` (new, max) | **0.10** | Default-on, smaller than positiveHit |

Exponential half-life decay table (B_max=0.10, τ=3d):

| Age | Boost | Note |
|---|---|---|
| 0h | 0.100 | full |
| 1d | 0.079 | |
| 3d | 0.050 | half-life |
| 7d | 0.020 | weak |
| 14d | 0.004 | near-0 |
| 20d (hard-filter edge) | 0.001 | ≈ 0, no floor needed |

`urgentlySeeking=true` user with today's full-time job = `0.20 + 0.10 = +0.30` — still safe, won't overflow `[0,1+]`.

---

## Don't-touch

- ❌ `V16_SCORE_WEIGHTS` (6 closed-sum components) — additive boost only
- ❌ `FRESHNESS_WINDOW_MS = 20d` hard filter — independent concern
- ❌ Query layer `orderBy firstSeenAt desc` — already correct
- ❌ Sort tiebreak — keep as final tiebreak

---

## Files touched

| File | Change |
|---|---|
| `apps/job-rec/src/tools/query-matching-jobs-v16.ts` | Add constants + score integration + breakdown field |
| `apps/job-rec/src/__tests__/tools/query-matching-jobs-v16.test.ts` | Add 4 cases (today/3d/7d/>7d) + ensure existing tests still pass |
| `apps/dashboard-web/src/pages/MatchDebug.tsx` (if exists) | Surface `freshnessBoost` in breakdown table |

---

## Done criteria

| # | Check | Pass condition |
|---|---|---|
| 1 | Test: today's job (age=0h) | `breakdown.freshnessBoost ≈ 0.10` |
| 2 | Test: 3d-old job | `breakdown.freshnessBoost ≈ 0.05` (half-life) |
| 3 | Test: 7d-old job | `breakdown.freshnessBoost ≈ 0.020` |
| 4 | Test: 20d-old job | `breakdown.freshnessBoost ≈ 0.001` (effectively 0) |
| 5 | Test: existing components still sum correctly | `breakdown.total = base + tagOverlap + positiveHit + urgency + freshness` |
| 6 | Live smoke: `__PA_FIND_MATCH__` for adam.ylol | Top-3 includes ≥1 job with `firstSeenAt` < 24h (assuming corpus has fresh jobs that day) |
| 7 | Match-debug UI | `freshnessBoost` column visible in breakdown |

---

## Risks

| Risk | Mitigation |
|---|---|
| Boost too strong → user sees only freshly-scraped low-quality jobs | 0.10 max — smaller than positiveHit (0.15) + smaller than urgency (0.20). Hard filter still drops dead URLs / bad role. |
| Today's job had bad enrichment → wins anyway | Independent concern; tag/enrich quality gates still apply pre-score. |
| Backward compat: tests asserting exact `total` values break | Update fixtures with new boost field added. |

---

## Branching

Branch from `main` into existing cleanup worktree stack:

```
.claude/worktrees/recency-boost-v16/   ← branch: feat/v16-recency-boost
```

Order: ship AFTER cleanup PHASE 1 (source-label code fix) lands on main, in
parallel with PHASE 2A (data delete) + PHASE 2B (chat-extraction). Independent
file scope (no overlap with cleanup or extraction).

---

## NON-GOALS

- No new query-layer ordering change
- No change to `FRESHNESS_WINDOW_MS = 20d` hard filter
- No LLM-based recency judgment (deterministic step-function only)
- No per-job-type freshness tuning (uniform across full_time/contract/intern)
