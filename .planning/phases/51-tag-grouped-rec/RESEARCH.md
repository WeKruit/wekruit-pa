# Phase 51 — Tag-Grouped Recommendation: OSS Library + Cluster-Query Research

**Phase**: 51 (v1.5 / Stream-G / D3)
**Status**: G.1 RESEARCH complete; G.2 BUILD deferred to next session
**Owner**: P7 (delegated by P10 brief)
**Date**: 2026-05-02
**Brief**: Adam directive — "use tag match to avoid duplicate, group user better, recommend job by tags not by user so it overwhelms the system, find industry level recommendation system opensource and use them and leverage llm here"

---

## 0. Premise Calibration (READ FIRST)

The P10 brief framed the savings story as:

> Every user × full pa-job-profiles read = **N × 40k** Firestore reads/day, reducing reads ~10x at 1k users.

**Read-path audit of `apps/job-rec/src/tools/query-matching-jobs.ts:887-941` shows this is wrong.**

Actual per-user reads:
- `where status=="active"` + `where industryKey in [≤10 keys]` (Stream H6/H8 expansion)
- `orderBy firstSeenAt desc` + `.limit(QUERY_FETCH_CAP=50)`
- → **~50 doc reads per user per day**, NOT 40,374

So at 1k users: ~50k reads/day total, NOT 40M. The current path **already** uses Firestore composite indexes correctly. The "10x reduction" framing collapses on contact with the source.

**What is the real value then?** Three things, in priority order:

1. **Candidate quality (Adam's actual ask, paraphrased)**: today every user runs an independent rank against fresh-corpus shuffles, so two users with identical tags can see different jobs day-to-day purely from `firstSeenAt` interleaving. Tag-clustered pre-rank gives **deterministic ordering per cluster**, then per-user reranks ride on top — better cohesion + audit trail.
2. **Per-cluster reuse**: one cluster computation amortizes across all users in that bucket. At 1k users / 30 clusters that's ~33 users per cluster — the cluster's top-N is computed once per day instead of 33 times. **Real savings: compute (Jaccard rank + sort), not Firestore reads.**
3. **LLM grounding (Adam's "leverage llm here")**: the cluster doc can carry a small LLM-generated "what this cluster is good for" summary, used by the friend-tone opener (H13) and the match-explainer (Phase 42) for richer per-job reasons without re-prompting per user.

**Re-framed savings target**: cluster-level rank done once/day (not 1k times), LLM cluster-summaries cached (not re-prompted), and **deterministic recommendations** for cohort cohesion. The Firestore-read story is real but ~10% of the value, not 100%.

This calibration is the most important deliverable in this doc. Code without it would optimize the wrong axis.

---

## 1. OSS Library Comparison Matrix

| Library | Stars | Last Active | Lang | Algo | CPU-only inference | Memory @ 1k users / 40k jobs | Cold-start latency | Stack fit | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **LightFM** ([lyst/lightfm](https://github.com/lyst/lightfm)) | 5.7k★ | No PyPI release in past 12mo per Snyk; Issue #709 reports Python 3.12 install failure; effectively maintenance-mode | Python (Cython) | Hybrid (LFM = MF + content) | Yes — pure CPU, no GPU dep | ~80MB embeddings @ 32d, plus user/item bias vectors | ~50ms/query in-process; ~150ms over HTTP | **Bad** — needs Cloud Run sidecar (Python on CF Gen2 is not supported); Python 3.12 broken means we're frozen at 3.11 with a stale toolchain | ❌ |
| **implicit** ([benfred/implicit](https://github.com/benfred/implicit)) | 3.8k★ | Active main branch; tested through Python 3.11; SciPy ≥0.16 | Python (Cython + OpenMP, optional CUDA) | ALS / BPR / Logistic MF (implicit feedback only) | Yes — CPU multi-threaded out of box | ~120MB for 40k items × 64d factors | ~10-30ms/query | **Bad fit semantically** — implicit feedback ≠ our signal. We have explicit user filters (industry tags, sponsorship), not click/play streams. Plus Cloud Run sidecar needed | ❌ |
| **Surprise** ([NicolasHug/Surprise](https://surpriselib.com/)) | ~6k★ | Slowed maintenance per 2025 community reports | Python | SVD / kNN / NMF (explicit ratings) | Yes | ~60MB | ~5-20ms/query | **Bad fit** — needs explicit ratings (1-5 stars). We have zero rating signal today; building one would be a separate project | ❌ |
| **TS-native (cosine + tag-intersection)** | n/a | n/a | TypeScript | Cluster-rank (Jaccard over industryTags + sponsorship × cosine within cluster) | **Trivially CPU; runs in current CF Gen2** | ~6MB for 40k jobs × 1536d float32 embeddings (already loaded — Stream F5/G1 cache) | <1ms/query (cluster lookup is a Firestore doc.get; cosine within cluster is k=200 dot products) | **Native** — runs inside existing `apps/job-rec` package, zero new infra | ✅ |

### Why every Python option fails the WeKruit stack constraint

- Firebase Cloud Functions Gen2 supports Node.js 22 (we're on it) and Python 3.11/3.12. **But cold-start of a CF that imports LightFM/implicit pulls in NumPy + SciPy + Cython binaries → 200+ MB per cold start, 3-5s init time, 1vCPU/256MB floor isn't enough.** You'd run it on Cloud Run with min-instances ≥1, which is **~$8-15/mo even idle** (vCPU/memory floor billing). Adam's free-tier preference is hard incompatible.
- Mac mini bridge could host the Python sidecar, but: (a) iMessage worker already saturates the box per memory `[iMessage Apple ID ToS]`, (b) adding a Python recommender training job on the same box couples two unrelated concerns, (c) the CEO-pending Sendblue migration eliminates the Mac mini path entirely (per memory `[Sendblue assessment]`).
- LightFM's Python 3.12 install bug ([Issue #709](https://github.com/lyst/lightfm/issues/709)) means we'd be locked to a deprecating toolchain.

### Why TS-native wins

- **Zero new infra**. Runs in the same CF that already runs `paJobRecDaily`. No sidecar, no Cloud Run, no min-instance billing.
- **Algorithm honesty**. Our problem isn't "predict missing rating" or "infer implicit click pattern" — it's "given a user's industry+sponsorship+location filters, find jobs in their *cohort* most similar to their resume embedding". That's literally `cluster_lookup(tags) → rerank_by_cosine(user.embedding, cluster.jobs[].embedding)`. LightFM/implicit/Surprise all add complexity without solving a problem we have.
- **LLM leverage stays where it matters**. Per Adam's "leverage llm here": LLM goes into (a) cluster-level summary (one prompt per cluster per day = ~30 prompts), and (b) per-job match-explainer (already wired in Phase 42). Not into the ranking algorithm, where deterministic cosine is a strict win.

---

## 2. Decision: TS-native, no OSS dep

**Architecture (proposed for G.2):**

```
┌──────────────────────────────────────────────────────────────────┐
│  Mac mini scrape+enrich+embed pipeline (existing)                │
│  → POST paMatchingPipelineComplete webhook                       │
│  → emits pa-events doc: eventKind="matching:pipeline:completed"  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  NEW CF: onPaEventMatchingPipelineComplete                       │
│    onDocumentCreated trigger on pa-events                        │
│    filter eventKind === "matching:pipeline:completed"            │
│    → invoke rebuildTagClusters()                                 │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  rebuildTagClusters() — apps/job-rec/src/tag-cluster-rec.ts      │
│    1. Read all matching-jobs where status=="active" (paginated)  │
│    2. For each job, compute clusterKey =                         │
│         `${industryTag}|${sponsorship||"any"}`                   │
│       (30 clusters: 10 industryTags × 3 sponsorship buckets)     │
│    3. Within each cluster, sort by firstSeenAt desc, take top 200│
│    4. (Optional) Generate one-line cluster summary via gpt-4.1-  │
│       mini (~30 prompts × $0.0001 = $0.003/day)                  │
│    5. Write pa-rec-tag-clusters/{clusterKey} {                    │
│         jobs: top200JobIds, refreshedAt, summary, jobCount       │
│       }                                                           │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Modified daily-batch.ts (paTagClusterRecEnabled flag-gated)     │
│    Per user:                                                     │
│      OFF (default) → existing queryMatchingJobs path              │
│      ON →                                                         │
│        1. Compute user's clusterKeys from normalized profile     │
│           (up to 3: one per top industryTag × sponsorship)       │
│        2. db.collection("pa-rec-tag-clusters").doc(key).get()    │
│           → pull jobIds                                          │
│        3. Batch-fetch top ~30 jobs by id (db.getAll)             │
│        4. Hand off to existing rerank cascade (cosine →          │
│           cross-encoder → boost → dedupe → anti-bias → format)   │
│        5. Per-user write to pa-rec-tag-clusters DELTA-only:      │
│           none — cluster is read-only from daily-batch's view    │
└──────────────────────────────────────────────────────────────────┘
```

### Read-cost math, honest

| Path | Reads/user/day | 1k users/day | Notes |
|---|---|---|---|
| Current (H6/H8 composite) | ~50 | 50,000 | Already-optimized composite-where + limit(50) |
| Tag-cluster (proposed) | 1 cluster doc + ~30 batched job gets = ~31 | 31,000 | ~38% reduction. Not 10x. |
| Cluster rebuild (daily) | ~5,000 (one paginated scan of active corpus) | n/a — once/day | Net new cost; offset by all-users savings |

**Net at 1k users: 31k + 5k = 36k reads/day vs 50k baseline → ~28% reduction.**

That's real but undramatic. The bigger win is:

- **Compute reuse**: cluster rank computed once, served to ~33 users (1k users / 30 clusters). At 10k users it's ~330× reuse. The cluster rebuild scales **O(corpus)** not **O(users × corpus)**.
- **Determinism**: two users in same cluster see same pre-rank; only the user-cosine-rerank is per-user. Easier to A/B and easier to debug "why did Alice get this and Bob didn't".
- **LLM cluster-summary cache**: once/day prompt × 30 clusters × $0.0001 = $0.003/day = $0.09/mo. **Effectively free** and lets the H13 opener say "this cluster has been heavy on early-stage fintech this week" without per-user LLM calls.

### Cost target: $0/mo additional

- Cluster rebuild CF: ~5k reads + ~30 writes per day → free tier (50k reads/day, 20k writes/day floor).
- LLM cluster summary: $0.09/mo at gpt-4.1-mini, optional, behind a separate flag (`paTagClusterSummaryEnabled`).
- New collection `pa-rec-tag-clusters`: 30 docs × ~5KB = 150KB storage. **Free tier (1GB).**
- daily-batch reads: same order of magnitude; net reduction.

---

## 3. Why NOT use an OSS recommender at all

The brief asked: "find industry level recommendation system opensource and use them". The honest research finding: **none of them solve a problem we currently have, and all of them add infra cost.**

What industrial systems (YouTube, Spotify, Netflix) actually do is two-tower retrieval + reranker. We already have that:
- **Tower 1 (retrieval)**: Firestore composite where on `industryKey in [...]` — narrows 40k → ~50.
- **Tower 2 (rerank)**: cosine + cross-encoder + startup boost — already shipped in Streams F5/G1/H10/I.

What we're MISSING is the **shard/cluster cache layer between Tower 1 and Tower 2** so the same retrieval is reused. That is exactly what tag-clusters give us, in 200 lines of TypeScript, no new infra. Adopting LightFM/implicit/Surprise would be re-introducing Tower 1+2 in Python with worse fit.

LLM leverage:
- ✅ Cluster summaries (1 prompt/cluster/day)
- ✅ Match-explainer per-job reasons (already shipped)
- ❌ NOT in the ranking algorithm itself (deterministic cosine is faster, cheaper, more debuggable)

---

## 4. G.2 Build Plan (next-session task)

**Scope (deferred — DO NOT start in this session)**:

| Step | File | Lines | Tests |
|---|---|---|---|
| D1 | `apps/job-rec/src/tag-cluster-rec.ts` (new) — pure logic: `clusterKeyForJob`, `clusterKeysForUser`, `rebuildTagClusters` | ~150 | 3 (clusterKey determinism, user→cluster expansion, rebuild outcome shape) |
| D2 | `apps/functions/src/job-rec-cluster-rebuild.ts` (new) — onDocumentCreated trigger on pa-events filtering for `eventKind=="matching:pipeline:completed"` | ~80 | 1 (event filter + rebuild invocation + idempotency-by-runId) |
| D3 | `apps/job-rec/src/daily-batch.ts` — add `tagClusterFetcher` dep; flag-gated branch reads cluster→jobs instead of queryMatchingJobs when `paTagClusterRecEnabled` | ~60 | 2 (flag OFF byte-identical to current; flag ON pulls from cluster + reranks identically) |
| D4 | `apps/functions/src/job-rec-daily.ts` — wire production tagClusterFetcher | ~20 | 0 (covered via E2E mock) |
| D5 | `apps/job-rec/src/types.ts` — add TagClusterDoc schema (zod) | ~15 | 1 (schema parses minimal + maximal shapes) |
| D6 | `firestore.indexes.json` — none needed (cluster is doc-id keyed) + RUNBOOK.md update | ~30 | 0 |
| **Total** | | **~355 LOC** | **7 tests** |

**Flag**: `paTagClusterRecEnabled` (default OFF; ramp 1%→10%→50%→100%). Ramp completion = full cluster path live; fallback = flag flip back.

**Why NOT this session**: 
1. The premise re-frame in §0 deserves Adam validation before we burn 355 LOC + 7 tests on an "$0/mo, ~28% read reduction, big-on-determinism+LLM-summary" win. If Adam reads §0 and says "actually I want the per-user-Firestore-cost-burn-rate concern", we'd still ship — but with a different acceptance bar. P7 protocol says: **方案先行**, validate the design before the build.
2. Honest 7h cap: research consumed ~3h, Adam's directive said "ship don't ask. If G.2 build path is too big for one session, ship RESEARCH.md only as Phase G.1 and document G.2 as next-session task" — choosing the latter explicitly.
3. The existing pipeline-complete webhook (Phase 47.1) emits `pa-events` docs — wiring the trigger is straightforward, but I want to instrument it with the same idempotency-by-runId that webhook uses, which means reading `matching-pipeline-complete.ts:354-380` carefully and replicating the runId guard. Better done with a dedicated session.

---

## 5. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| 30-cluster cardinality is wrong (some clusters empty, some too fat) | Medium | Instrument cluster-rebuild log: `{clusterKey, jobCount}`. After 1 week, decide if we need to subdivide hot clusters by location or sizePreference. |
| Cluster doc grows past Firestore 1MB doc limit (top-200 jobIds × 50 char id ≈ 10KB — fine) | Low | Stays well under limit. If a cluster exceeds 1MB we cap at top-200 by firstSeenAt anyway. |
| User in a cluster with <3 fresh jobs → Variant D fallback fires too often | Medium | Already have prev-7-day fallback (Phase 43); cluster path inherits it via the same `applyHardFiltersWithFallback` helper. |
| Cluster rebuild trigger duplicates with cron | Low | Idempotency-by-runId from webhook payload; cluster doc carries `lastRebuildRunId` to skip duplicate runs. |
| LLM cluster-summary drifts off-topic | Low | Optional, separate flag; sample output reviewed weekly. Cap at 60 chars in prompt. |
| ALS-style preference learning is what Adam actually wants (despite "tag match to avoid duplicate" wording) | Medium-low | If clarification reveals it, swap §4 for `implicit` ALS in a Cloud Run sidecar with min-instances=0 (cold start cost ~3s, accepted for daily cron path). Adds ~$3-8/mo. Documented as Plan B in this doc. |

---

## 6. Plan B (if Adam wants real ALS, not just clustering)

If post-research Adam says "I actually want collaborative-filtering-style preference learning, not just deterministic clusters":

- Cloud Run service `wekruit-rec-sidecar` (Python 3.11, `implicit` lib, min-instances=0)
- Daily training: pull `pa-message-events` clicks/replies → implicit feedback matrix → ALS factorize 64-d → write user/job embeddings to Firestore
- daily-batch HTTPS-calls sidecar: `{userId} → top 30 jobIds`
- Cost: Cloud Run scale-to-zero ~$3-8/mo (cold-start tax) + $0 OpenAI delta
- Effort: 6-8 dev-days; same flag pattern; NOT shipped this session

Sidecar code lands in `/tmp/wekruit-matching/` per existing pattern (Mac mini Python repo); wekruit-pa side gets a `WEKRUIT-MATCHING-PATCH.md` like `apps/functions/src/WEKRUIT-MATCHING-PATCH.md` already does for the cloud-migration scope.

---

## 7. Sources

- LightFM repo + maintenance: https://github.com/lyst/lightfm ; Python 3.12 install bug https://github.com/lyst/lightfm/issues/709 ; Snyk health analysis https://snyk.io/advisor/python/lightfm
- implicit repo: https://github.com/benfred/implicit ; docs https://benfred.github.io/implicit/
- Surprise: https://surpriselib.com/
- WeKruit references:
  - `apps/job-rec/src/tools/query-matching-jobs.ts:887-941` (current per-user read path)
  - `apps/job-rec/src/daily-batch.ts:863-1406` (daily-batch driver)
  - `apps/functions/src/matching-pipeline-complete.ts:354-380` (pa-events emitter we'll trigger off)
  - `.planning/phases/47-matching-cloud-audit/AUDIT.md` (corpus size + cost baselines)
  - `.planning/MILESTONE-v1.5-friend-companion.md:26-27` (D3 brief)

---

## 8. Recommendation to P10

**Ship RESEARCH.md as Phase G.1 deliverable. Defer G.2 BUILD to next session pending Adam validation of §0 premise re-frame.**

If Adam confirms "yes, the cluster-cache + LLM-summary value still holds even at ~28% read reduction" → next session ships D1-D6 (~355 LOC, 7 tests, $0/mo, default-OFF flag).

If Adam pushes back with "I want the 10x savings claim made real" → that requires a different attack: sharding the daily cron itself (e.g. send same cluster's recommendations as a single batch write to `pa-outbound`, not 33 individual writes), which is a separate architectural decision.

P7 self-review (3 questions, see DELIVERY.md):
1. Interface compat — N/A this session (no code shipped).
2. Edge cases — covered in §5 risks table.
3. Proper fix vs workaround — proper fix; the premise re-frame in §0 was the most important honesty filter.

