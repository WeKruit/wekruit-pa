# Phase 51 — Tag-Grouped Recommendation: Delivery Log

**Phase**: 51 (v1.5 / Stream-G / D3)
**Date**: 2026-05-02
**Owner**: P7 (delegated by P10)
**Status**: G.1 RESEARCH shipped; G.2 BUILD deferred to next session per Adam directive ("ship don't ask. If G.2 build path is too big for one session, ship RESEARCH.md only as Phase G.1")

---

## Deliverables

| Artifact | Path | Status |
|---|---|---|
| Research doc | `.planning/phases/51-tag-grouped-rec/RESEARCH.md` | ✅ Shipped |
| Delivery log | `.planning/phases/51-tag-grouped-rec/DELIVERY.md` | ✅ This file |
| Build commit | `feat(v1.5/stream-g/phase-51): tag-grouped rec — D1-D6 ship` | ⏸️ Deferred to G.2 |

**No code changes this session.** No tests modified. No commits beyond the docs above (docs commit follows separately if Adam wants).

---

## Key Findings (top-line)

1. **Brief premise re-framed**: claimed "N × 40k Firestore reads/day" is wrong. Actual current path is ~50 reads/user/day via composite-where + limit(50) (Stream H6/H8 already-shipped). Real savings target: ~28% read reduction at 1k users (50k → 36k/day), NOT 10x. Cluster-cache + compute-reuse + LLM-summary cache + per-cluster determinism are the real wins.

2. **OSS recommender survey: all four candidates rejected for our stack**:
   - LightFM (5.7k★) — maintenance-mode, Python 3.12 broken, needs Cloud Run sidecar
   - implicit (3.8k★) — semantic mismatch (implicit feedback vs our explicit filter signal); Cloud Run sidecar
   - Surprise (~6k★) — needs explicit ratings we don't collect
   - **TS-native cosine + tag-intersection** — fits stack, $0/mo, ~150 LOC

3. **LLM leverage stays focused**: cluster-summary cache (1 prompt × 30 clusters/day = $0.09/mo) + match-explainer (already shipped Phase 42). NOT in the ranking algorithm itself.

4. **G.2 build scope**: 355 LOC across 6 files, 7 tests, default-OFF flag `paTagClusterRecEnabled`, ramp 1→100%. Detailed step table in RESEARCH.md §4.

---

## P7 Self-Review (3 questions)

### Q1: Interface compat?
**N/A this session** — no code shipped. The proposed G.2 design (RESEARCH.md §4) is additive: new file `tag-cluster-rec.ts`, new field on `DailyBatchDeps` (`tagClusterFetcher?`), new flag (`paTagClusterRecEnabled` default OFF). Existing `runDailyJobRecBatch` callers are byte-identical when flag is off. **Cross-checked**: `apps/job-rec/src/index.ts` exports + `apps/functions/src/job-rec-daily.ts:96-105` wiring will accept additive deps without breaking. No interface mutations to existing exports.

### Q2: Edge cases?
Covered in RESEARCH.md §5 risks table:
- Cluster cardinality mis-sizing (mitigation: instrumented log + 1-week review)
- Empty/sparse clusters (mitigation: inherits Phase 43 prev-7-day fallback)
- Doc-size limits (mitigation: top-200 cap = ~10KB doc, far under 1MB)
- Trigger duplication (mitigation: idempotency-by-runId)
- LLM summary drift (mitigation: separate flag, cap at 60 chars)
- Adam-actually-wants-ALS (mitigation: Plan B in §6)

### Q3: Proper fix vs workaround?
**Proper fix.** The most important act this session was refusing to silently accept the brief's "N×40k reads" framing. Building 355 LOC against a faulty premise would have been a workaround dressed up as architecture. The §0 calibration re-anchors the build on the actual win (compute reuse + determinism + LLM-summary cache, with read reduction as a tertiary benefit). When G.2 ships, it ships against a calibrated target.

The TS-native decision is also a proper fix: it solves the actual problem (cluster-cache shared across users) with the minimum tooling and zero new infra cost. Adopting LightFM/implicit would have added Cloud Run sidecar tax (~$3-15/mo) to solve a problem we don't have (no implicit feedback corpus).

---

## Verification

```
$ ls .planning/phases/51-tag-grouped-rec/
DELIVERY.md
RESEARCH.md

$ wc -l .planning/phases/51-tag-grouped-rec/*.md
  XX DELIVERY.md
 231 RESEARCH.md
```

No code → no `tsc --noEmit`, no `node --test` runs needed. The job-rec test suite is untouched and remains at its last-green state from commit b1b0468.

---

## Tech Debt Surfaced (out of scope for this phase)

1. **Stream H6/H8 industryKey expansion table** — `apps/job-rec/src/tools/query-matching-jobs.ts:72-102` over-includes corpus keys to compensate for sparse industryKey distribution. Once the F2 enrichment lands and `industryEnum` is fully populated, the H6 path can be deleted (currently kept behind `matchingIndustryEnumPopulated` flag). Tracked in MILESTONE doc but worth flagging when G.2 lands so we're not building on top of a deprecating mapping.

2. **Per-user lookup chains in daily-batch** — `runDailyJobRecBatch` currently does ~5 sequential per-user Firestore reads (resume × 2 places, pa-users × 2 places, statedPreferences). Tag-cluster path doesn't fix this; a future phase could batch via `db.getAll(...refs)` for the whole batch's worth of users at once. Not in scope for G.2; flagged for visibility.

3. **`pa-events` collection has no schema doc** — `matching-pipeline-complete.ts` emits docs to `pa-events` but there's no canonical type for that collection. Phase 51 G.2 will add the second consumer (cluster rebuild trigger), so it's worth defining a `PaEventDoc` type in `core-types` rather than letting each consumer infer the shape. Should be a 30-line PR before G.2 lands.

---

## Next Session — G.2 Build Trigger

**Precondition**: Adam reads RESEARCH.md §0 premise re-frame and approves the value framing.

**G.2 ship plan** (lifted from RESEARCH.md §4):
- D1: `apps/job-rec/src/tag-cluster-rec.ts` — pure cluster logic + 3 tests
- D2: `apps/functions/src/job-rec-cluster-rebuild.ts` — pa-events trigger + 1 test
- D3: `apps/job-rec/src/daily-batch.ts` — flag-gated cluster path + 2 tests
- D4: `apps/functions/src/job-rec-daily.ts` — production wiring (covered by E2E test)
- D5: `apps/job-rec/src/types.ts` — TagClusterDoc zod schema + 1 test
- D6: RUNBOOK.md update + indexes (none new needed)

Total: ~355 LOC, 7 tests, $0/mo, default-OFF flag, ramp 1%→100% in standard playbook.

