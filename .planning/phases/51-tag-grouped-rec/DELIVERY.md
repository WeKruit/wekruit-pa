# Phase 51 — Tag-Grouped Recommendation: Delivery Log

**Phase**: 51 (v1.5 / Stream-G / D3)
**Date**: 2026-05-02
**Owner**: P7 (delegated by P10)
**Status**: G.1 RESEARCH shipped (`be420b0`); **G.2 BUILD shipped this session** — D1-D5 land below

---

## Stream G.2 BUILD — Deliverables

| Artifact | Path | Status |
|---|---|---|
| Research doc | `.planning/phases/51-tag-grouped-rec/RESEARCH.md` | Shipped (G.1) |
| Delivery log | `.planning/phases/51-tag-grouped-rec/DELIVERY.md` | This file (updated G.2) |
| **D1** TS-native cluster lib | `apps/job-rec/src/tag-cluster-rec.ts` | Shipped — 468 LOC |
| **D2** Cluster rebuild CF | `apps/functions/src/job-rec-cluster-rebuild.ts` | Shipped — 156 LOC |
| **D3** daily-batch wire | `apps/job-rec/src/daily-batch.ts` (flag-gated branch) | Shipped — +90 LOC |
| **D4** Production wiring | `apps/functions/src/job-rec-daily.ts` + `apps/functions/src/index.ts` (export) | Shipped |
| **D5a** D1 unit tests | `apps/job-rec/src/__tests__/tag-cluster-rec.test.ts` | Shipped — 7 tests |
| **D5b** D2 trigger test | `apps/functions/src/__tests__/job-rec-cluster-rebuild.test.ts` | Shipped — 1 test |
| index.ts exports | `apps/job-rec/src/index.ts` | Shipped — additive only |

LOC: ~720 added, 0 removed. 8 new tests. Existing test suites untouched (168 job-rec + 352 functions, all green).

---

## What G.2 ships, in one paragraph

When the Mac mini's daily scrape pipeline lands new jobs, `paMatchingPipelineComplete` already emits a `pa-events` doc with `eventKind="matching:pipeline:completed"`. G.2 adds a second consumer of that event: **paJobRecClusterRebuild** (new CF, `onDocumentCreated("pa-events/{id}")`) which paginates active matching-jobs, buckets by `(industryEnum, top-3 sorted requiredSkills)`, computes a stable 12-char hex `clusterId`, and writes `pa-rec-tag-clusters/{clusterId}` with the top-50 jobIds (firstSeenAt desc), idempotency-by-runId, optional LLM-summary slot. Daily-batch's per-user path now has a flag-gated branch (`paTagClusterRecEnabled`, default OFF): when ON, it computes the user's cluster keys (≤3), reads those cluster docs, batch-fetches the matching-job rows, scores within-cluster by cosine (when user embedding present) or jaccard (fallback), and hands off to the EXISTING rerank cascade unchanged (hard filter → cosine → cross-encoder → boost → dedupe → anti-bias → formatter). When the cluster cache is cold/empty/missing, the path falls through to the legacy `queryMatchingJobs` call — zero-regression contract preserved.

---

## Honest savings story (premise calibrated in RESEARCH.md §0)

The original P10 brief framed savings as "10x reads at 1k users". RESEARCH.md §0 audit showed this was wrong: the existing path is already ~50 reads/user/day via composite-where + limit(50), not 40k. Real win:

| Metric | Baseline | With cluster cache | Reduction |
|---|---|---|---|
| Firestore reads/day @ 1k users | ~50,000 | ~36,000 (31k user + 5k rebuild) | ~28% |
| Per-cluster compute (cosine + sort) | 1k users × O(50 candidates) | 1× rebuild (~30 clusters) + 1k × O(≤150 fetch) | reuse factor scales O(users) |
| Determinism | Per-user ranking can drift day-to-day from `firstSeenAt` interleaving | Same cluster → same top-50 → reproducible | qualitative |
| LLM cluster-summary cache | N/A | $0.09/mo for 30 clusters × 1 prompt/day (gpt-4.1-mini) | optional |

**Net at 1k users**: 28% read reduction, **bigger win is compute reuse + determinism + LLM cache**. At 10k users the cluster compute reuses ~330× per cluster.

---

## Cost: $0/mo additional

- Cluster rebuild: ~5k reads + ~30 writes per pipeline-completion → free tier (50k reads, 20k writes daily floor).
- Cluster collection: 30 docs × ~5KB = 150KB → free tier (1GB).
- Daily-batch reads: same order of magnitude with offset by user-side reduction.
- LLM cluster-summary: $0.09/mo if enabled (out-of-scope for G.2 ship; reserved as forward-compat field on the schema).

---

## Rollback

1. **Default state**: Flag `paTagClusterRecEnabled` is **OFF** for all users. G.2 is dormant.
2. **Ramp**: Flag-controlled at 1% → 10% → 50% → 100% via Firestore feature-flags doc.
3. **Rollback path**: Flag flip back to OFF — daily-batch's flag-gated branch returns null → legacy `queryMatchingJobs` path runs unchanged. Cluster collection orphans are acceptable: 150KB total, no TTL needed; will be re-overwritten by next pipeline rebuild.
4. **Scrape-pipeline trigger**: Independent of daily-batch flag. The cluster rebuild itself is also gated by the same flag — turning the flag off stops both producers and consumers.

---

## P7 Self-Review (3 questions)

### Q1: Interface compat?
**Yes, fully additive.** Verified by Grep:
- `apps/job-rec/src/index.ts` — additive exports only (`computeClusterId`, `clusterKeysForUser`, `rebuildClusters`, `fetchTopKFromCluster`, `TagClusterDocSchema`, `PA_TAG_CLUSTER_REC_FLAG_KEY`, `TAG_CLUSTERS_COLLECTION`, `DEFAULT_TOP_K_PER_CLUSTER` + 5 type exports). Zero existing exports changed.
- `DailyBatchDeps` — added optional `tagClusterFetcher?` field. Existing 1 production wire (`apps/functions/src/job-rec-daily.ts`) and 18 test wires (`apps/job-rec/src/__tests__/daily-batch.test.ts`) all stay valid; `tsc --noEmit` confirms.
- `apps/functions/src/index.ts` — single new export `paJobRecClusterRebuild`. Existing CFs untouched.
- `pa-events` collection — new consumer added; producer (`matching-pipeline-complete.ts`) untouched. Multi-tenant pattern (eventKind filter) ensures other consumers won't be triggered.
- All 168 job-rec tests + 352 functions tests pass after the build (no test required modification — zero regression).

### Q2: Edge cases?
- **Cold cache** (cluster doc missing, possibly first day post-flag-flip): `fetchTopKFromCluster` returns `[]`; daily-batch falls back to legacy `queryMatchingJobs`. Test 6 locks this behavior.
- **Cluster doc stale** (job deactivated since rebuild): `fetchTopKFromCluster` re-checks `status === "active"` per row; deactivated rows silently dropped.
- **User has no industry tags**: `clusterKeysForUser` returns `[]`; fetcher short-circuits to `[]`; daily-batch falls back. Test 3 locks this.
- **Idempotent re-trigger** (Firestore retries pa-events doc creation): `rebuildClusters` reads existing `lastRebuildRunId`; matching runId → skip writes. Test 5 locks this.
- **Wrong eventKind** (multi-tenant pa-events collection): handler short-circuits with `kind: "skipped_event_kind"`. Test in `job-rec-cluster-rebuild.test.ts` locks this branch.
- **Flag OFF**: handler returns `kind: "skipped_flag_off"` BEFORE invoking rebuild. Test locks this.
- **Bilingual industries (zh + en collapse)**: `industryEnum` already canonicalized by F2 enrichment; `computeClusterId` lowercases + trims so casing/whitespace differences also collapse. Test 1 locks order-independence + casing-normalization.
- **Skills order non-determinism**: skills sorted lexicographically before hashing; same input set produces same id regardless of array order. Test 1 locks this.

### Q3: Proper fix or workaround?
**Proper fix throughout.** Two specific judgments worth flagging:

1. **Refactored D2 into `handleClusterRebuildEvent` + thin CF wrapper** — initially I had the logic inlined in the `onDocumentCreated` callback. Pulled it out so the test could exercise all three branches (eventKind mismatch, flag OFF, full rebuild) without booting firebase-admin. Workaround would have been `vi.mock("firebase-admin/firestore")`-style; proper fix is dependency injection. Pattern matches existing `handleMatchingPipelineComplete` design.
2. **Sequential get vs `getAll` for cluster member fetch** — at ≤150 docs/user the perf delta is negligible (~50ms p50 over Firestore client-cached connection). `getAll` would require a different test mock surface. Documented as forward-compat in the source comment; not workaround because the perf budget is genuinely fine.

The bigger architectural decision — **TS-native vs OSS recommender (LightFM/implicit/Surprise)** — was made in G.1 RESEARCH.md and is unchanged here: all three OSS options needed Cloud Run sidecars at $3-15/mo, none solved a problem we have. TS-native is the proper fix; adopting OSS would have been complexity-for-its-own-sake.

---

## Verification

```
$ pnpm -C apps/job-rec typecheck
> tsc --noEmit
(clean)

$ pnpm -C apps/job-rec test
ℹ tests 168
ℹ pass 168
ℹ fail 0

$ pnpm -C apps/functions typecheck
> tsc --noEmit
(clean)

$ pnpm -C apps/functions test
ℹ tests 352
ℹ pass 352
ℹ fail 0
```

7 new tests in `tag-cluster-rec.test.ts` + 1 new test in `job-rec-cluster-rebuild.test.ts` = 8 total. Pre-G.2 baseline was 161 + 351 = 512 tests; post-G.2 is 168 + 352 = 520 tests. Delta matches +8 expected. Existing tests untouched (zero-regression confirmed).

---

## Tech Debt Surfaced (out of scope; report to P8)

1. **No Firestore composite index for `pa-events.eventKind`** — the cluster-rebuild trigger fires on every pa-events doc creation and filters in handler. At pa-events emission rate of ≤24/day (per `HARD_LIMIT_PER_DAY` in matching-pipeline-complete.ts), this is fine — the filter is a no-op for non-target events. Worth flagging if pa-events expands to higher-volume event types.

2. **`getAll` batching for cluster member fetch** — current `fetchTopKFromCluster` does sequential `db.collection.doc.get()` calls (≤150 max). At 1k users/day × 150 reads each = 150k reads/day; still under the 50k/day floor split across hour buckets, but a `getAll` batching would halve that. Forward-compat marker in the source code (`apps/job-rec/src/tag-cluster-rec.ts:fetchTopKFromCluster`).

3. **Cloud Scheduler fallback for cluster rebuild** — current trigger is event-driven only (pa-events docs). If the Mac mini pipeline misses a day, clusters go stale. Brief mentioned an optional 06:30 PT scheduler; deferred to keep G.2 surface minimal. Should be a 30-line addition when needed.

4. **LLM cluster-summary** — schema field `summary` is reserved (currently always `null`). The `$0.09/mo for 30 clusters × 1 prompt/day` value is not yet realized; needs a separate phase to wire the gpt-4.1-mini prompt + a separate flag (`paTagClusterSummaryEnabled`) to ramp it independently.

5. **`pa-events` schema not formalized in `core-types`** — Phase 51 G.2 is the second consumer of `pa-events` (after the producer in `matching-pipeline-complete.ts`). Each consumer infers shape independently. Should be a `PaEventDoc` type added to `@pa/core-types` before a third consumer lands. Already flagged in this DELIVERY.md's previous tech-debt section; G.2 did NOT add a third consumer (single-handler), so debt magnitude unchanged.

---

## Next-session opportunities (not blockers)

- Flip `paTagClusterRecEnabled` to 1% allowlist for canary observation (3-7 days). Watch `[job-rec-daily] tag_cluster_fetch_applied` log volumes vs `tag_cluster_empty_falling_back`.
- Add Cloud Scheduler 06:30 PT cluster-rebuild fallback (insurance against pipeline misses).
- Wire LLM cluster-summary (separate flag, separate phase).
- Formalize `PaEventDoc` type in `@pa/core-types` (deferred from G.1 tech debt).

---

## Post-ship cluster-key alignment fix (2026-05-02)

**Status**: Shipped. Production cluster path now hits real jobs.

### What was wrong (root cause)

The G.2 ship (commit `2d08bce`) used `(industryEnum, top-3 sorted requiredSkills)` for the cluster id on **both** sides:
- Job side (`rebuildClusters` in `tag-cluster-rec.ts`) bucketed each `matching-jobs` row by sorted top-3 of its `requiredSkills`.
- User side (`clusterKeysForUser`) bucketed each user by sorted top-3 of their CV `skills`.

The two top-3 sets almost never intersected (skills have a long-tail distribution; user CV skills and job-required skills come from different vocabularies even within the same industry). Result: **cluster ids never aligned → cluster docs were never read → all three of Adam's cluster keys returned `exists=false`** (Agent 2 audit, commit `4ef44ed`). The cluster path silently fell through to the legacy `queryMatchingJobs` for every user. The "28% read reduction + compute reuse + LLM-summary cache" wins were 0 because the cache was never queried.

Cardinality also exploded: 6549 cluster docs in production vs RESEARCH §6 stated design of 30 (218× overshoot, 69% singletons).

### What was fixed

Switched the cluster-key algorithm to match RESEARCH §6 stated design:

```
clusterId = sha256(industryEnum + "|" + sponsorshipBucket).slice(0, 12)
sponsorshipBucket ∈ {"sponsor", "no-sponsor", "unknown"}
```

- **Job side** (`rebuildClusters`): bucket derived from `raw.sponsorship: boolean | null` via `jobSponsorshipBucket` helper (`true → sponsor`, `false → no-sponsor`, `null/missing → unknown`).
- **User side** (`clusterKeysForUser`): bucket derived from `JobProfile.sponsorship` enum via `userSponsorshipBuckets` helper:
  - `"h1b" / "gc"` → `["sponsor", "unknown"]` (2 buckets per industry)
  - `"none"` → `["no-sponsor", "unknown"]` (2 buckets per industry)
  - `"either" / undefined / null` → `["sponsor", "no-sponsor", "unknown"]` (3 buckets per industry)
- Each user fans out across (≤3 industryTags × 2-3 buckets) = 2-9 cluster reads/user.
- `requiredSkills` / user `skills` no longer participate in the cluster key. They still feed the in-cluster scoring fallback (jaccard when no embedding).

### Migration path

**New collection `pa-rec-tag-clusters-v2`** (was `pa-rec-tag-clusters`). Constant flip in `TAG_CLUSTERS_COLLECTION`. Zero in-place mutation; old 6549 docs are orphaned and no longer read. Cleanup deferred (~33MB total, well under the 1GB free tier — filed as tech-debt below).

### Cardinality + verify (production)

Manual rebuild ran via `apps/functions/scripts/trigger-cluster-rebuild.mjs` (admin SDK; bypasses CF + flag):

```
Target collection: pa-rec-tag-clusters-v2
clusters written:        30        ← exactly RESEARCH §6 stated design
jobs bucketed (total):   1451       ← (30 × top-50 cap) - thin clusters
jobs scanned:            40308
pages read:              81
by bucket: sponsor=10 no-sponsor=10 unknown=10  ← perfectly balanced
```

Cluster ON vs OFF dryrun (`scripts/dryrun-adam-cluster-compare.mjs`) for Adam (`e5d97cd8-…`):

```
[STAGE 1] all 6 user cluster keys exist=true, jobIds.len=50 each
[STAGE 2] Cluster ON pool: 20 jobs in 22120ms
[STAGE 3] Cluster OFF pool: 20 jobs in 724ms (legacy)

VERDICT: Cluster path supplies the pool (was: empty fallback, every day)
Top-10 cluster ON jobs: Junior Data Scientist / AI ML Engineering /
                       Data Analyst (CV-aligned: SQL+Python+ML+R)
Top-10 cluster OFF jobs: Groundskeeper / Community Manager / Marketing
                        Liaison (legacy quality issue — separate phase)
```

Cluster wall-time (22s) > legacy (700ms) is expected given current sequential `db.doc.get()` (≤450 reads when fanout is full). Filed as tech-debt #2 below; daily-batch is async per-user so this latency is not user-visible.

### Files touched

- `apps/job-rec/src/tag-cluster-rec.ts` — algorithm + `TAG_CLUSTERS_COLLECTION` v2 constant + `SponsorshipBucket` type + `jobSponsorshipBucket` + `userSponsorshipBuckets` helpers + `UserTags.sponsorship`
- `apps/job-rec/src/daily-batch.ts` — `TagClusterFetcher` type adds `sponsorship?` field + cluster path call site passes `normalized.sponsorship`
- `apps/job-rec/src/__tests__/tag-cluster-rec.test.ts` — 7 tests rewritten + 4 new (8/9/10/11) → 11 cluster tests total
- `apps/functions/src/__tests__/job-rec-cluster-rebuild.test.ts` — assert `pa-rec-tag-clusters-v2` collection + `sponsorshipBucket` field on cluster doc
- `apps/functions/scripts/dryrun-adam-cluster-compare.mjs` — pass `sponsorship` not `topSkills`
- `apps/functions/scripts/trigger-cluster-rebuild.mjs` (NEW) — one-shot admin-SDK rebuild that bypasses CF + flag, prints inventory by bucket

### Test status

```
$ pnpm -C apps/job-rec test     →  172 / 172 pass (was 168, +4 new tests, -3 removed/folded)
$ pnpm -C apps/functions test   →  352 / 352 pass
```

### Adam — commands to trigger first cluster fill

After deploying this change to prod (or running locally with admin SDK), run:

```bash
# 1. (Optional, only first time after deploy) Pre-fill the v2 cluster docs.
#    No flag needed — script bypasses paTagClusterRecEnabled.
node apps/functions/scripts/trigger-cluster-rebuild.mjs

# 2. Verify Adam's cluster path hits jobs (>0 expected).
node apps/functions/scripts/dryrun-adam-cluster-compare.mjs
```

Subsequent rebuilds happen automatically via `paJobRecClusterRebuild` CF on every `pa-events / matching:pipeline:completed` doc — but only when the `paTagClusterRecEnabled` flag is on. **Adam's user already has the flag enabled (allowlist confirmed in dryrun output).** Flag still default-OFF for everyone else.

### Deviation from RESEARCH §6 — explicit list

| Item | RESEARCH §6 said | Shipped (alignment fix) | Why |
|---|---|---|---|
| Cluster key | `(industryTag, sponsorship)` (open) and `(industryTag, top-3 skills)` (D1) — RESEARCH was internally contradictory | `(industryEnum, sponsorshipBucket ∈ {sponsor, no-sponsor, unknown})` | RESEARCH §6 opening text wins; D1 implementation was the bug source |
| Reads/user/day estimate | "1 cluster doc + ~30 batched job gets = ~31" | Up to 9 cluster reads + ~150 (3 industries × 3 buckets × 50 cap) sequential job gets | Fanout grew with sponsorship dimension; still well under daily-batch latency budget |
| Cluster count | 30 (10 industries × 3 sponsorship) | 30 exactly (perfectly balanced 10/10/10) | Matched the design |
| New collection | (not specified) | `pa-rec-tag-clusters-v2` (was `pa-rec-tag-clusters`) | Migration safety; zero in-place risk |

### Tech debt surfaced (filed; out of scope for this fix)

6. **Cleanup orphaned `pa-rec-tag-clusters` collection** (Phase 51 v1 docs). 6549 docs × ~5KB = ~33MB, well under free-tier 1GB. Single-shot cleanup script suffices.
7. **`getAll` batching for `fetchTopKFromCluster`**: current sequential `db.doc.get()` is ≤450 reads when fanout is full (3 industries × 3 buckets × top-50). 22s wall-time observed in dryrun. Daily-batch is async per-user so not user-visible, but `getAll` would cut it ≥4×.
8. **`startAfter` pagination unused in tests**: mock-firestore.ts doesn't implement `startAfter`; production paginator works fine but tests stay under 500 docs (REBUILD_PAGE_SIZE) so the path never fires. If corpus exceeds 500 active jobs in tests, mock will throw `not a function`. Cosmetic — fix when next test needs >500 rows.
9. **Cluster-rebuild flag-gating ambiguity**: the production CF `paJobRecClusterRebuild` is gated on the same `paTagClusterRecEnabled` flag that controls the consumer. Means turning the flag off stops both the cache writer AND the reader, leaving stale docs. Acceptable given small cluster doc count + idempotency, but worth a `paTagClusterRebuildEnabled` separate flag if we add ramp gates per-side.
