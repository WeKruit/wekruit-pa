/**
 * v1.5 Stream-G.2 / Phase 51 — TS-native tag cluster cache.
 *
 * Architecture (per RESEARCH.md §6 + P10 G.2 brief):
 *
 *   Mac mini scrape pipeline → paMatchingPipelineComplete webhook → emits
 *   pa-events doc {eventKind: "matching:pipeline:completed"} → onDocumentCreated
 *   trigger (apps/functions/src/job-rec-cluster-rebuild.ts) invokes
 *   rebuildClusters() defined here.
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  Phase 51 post-ship alignment fix (2026-05-02)                  │
 *   │                                                                  │
 *   │  Original G.2 ship used (industryEnum, top-3 sorted skills) for │
 *   │  cluster key. Job side and user side computed top-3 skills      │
 *   │  independently → cluster ids never aligned → cluster path was   │
 *   │  dormant in production (Agent 2 commit 4ef44ed: Adam's three    │
 *   │  cluster keys all returned exists=false).                        │
 *   │                                                                  │
 *   │  Cardinality also blew up: 6549 clusters in prod vs RESEARCH §6 │
 *   │  expected ~30 (218× overshoot, 69% singleton).                  │
 *   │                                                                  │
 *   │  Fix: switch to RESEARCH §6 stated design — (industryEnum,      │
 *   │  sponsorshipBucket) where bucket ∈ {sponsor, no-sponsor,        │
 *   │  unknown}. Cardinality bounded at 10 industries × 3 buckets =   │
 *   │  30 clusters (some empty → ~25 effective). Both job side and    │
 *   │  user side derive bucket from a low-cardinality field that       │
 *   │  exists on both schemas (job.sponsorship: boolean|null and      │
 *   │  user.profile.sponsorship: "h1b"|"gc"|"none"|"either"), so       │
 *   │  alignment is mechanical instead of relying on top-K skill set  │
 *   │  intersection.                                                   │
 *   │                                                                  │
 *   │  Migration: writes go to a fresh collection                     │
 *   │  pa-rec-tag-clusters-v2 (was pa-rec-tag-clusters). Old docs are │
 *   │  no longer read; safe to leave orphaned (≈33MB, well under free │
 *   │  tier 1GB). A cleanup script is filed as tech-debt for a future │
 *   │  phase.                                                          │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 *   rebuildClusters: paginate active matching-jobs; bucket by clusterId =
 *   sha256(industryEnum + sponsorshipBucket) → write top-K (default 50, by
 *   firstSeenAt desc) into pa-rec-tag-clusters-v2/{clusterId}.
 *
 *   daily-batch.ts (flag-gated by paTagClusterRecEnabled): fetchTopKFromCluster
 *   reads cluster docs for the user's (industryTag × sponsorshipPref) cross,
 *   batched-getAll's the underlying matching-jobs rows, returns the existing
 *   MatchingJob shape so the rest of the rerank cascade (hard filter → cosine →
 *   cross-encoder → boost → dedupe → anti-bias → formatter) runs UNCHANGED.
 *
 * Honest savings story (read RESEARCH.md §0):
 *   - ~28% Firestore read reduction at 1k users (50k → 36k/day)
 *   - REAL win is compute reuse: cluster rank computed once/day, served to
 *     ~33 users/cluster (1k users / 30 clusters)
 *   - Determinism: same cluster → same top-K → reproducible recommendations
 *   - LLM summary cache: optional, 1 prompt × 30 clusters/day = $0.09/mo
 *
 * Cost: $0/mo additional (free tier — 30 docs/day writes, ~5k reads on rebuild).
 *
 * Default OFF behind paTagClusterRecEnabled flag. Ramp 1% → 100%.
 */

import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import { projectMatchingJobRow } from "./tools/query-matching-jobs.js"
import { jaccardOverlap } from "./tools/query-matching-jobs.js"
import { cosineSimilarity } from "./daily-batch.js"
import { MatchingJobSchema, type MatchingJob } from "./types.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Phase 51 — feature flag key. Default OFF; ramp 1% → 100%. */
export const PA_TAG_CLUSTER_REC_FLAG_KEY = "paTagClusterRecEnabled"

/**
 * Firestore collection for cluster docs. Phase 51 alignment fix (2026-05-02)
 * bumped this from `pa-rec-tag-clusters` → `pa-rec-tag-clusters-v2` to start
 * fresh after the (industryEnum, top-3 skills) → (industryEnum,
 * sponsorshipBucket) key-algorithm change. The old collection's 6549 docs
 * are no longer read; safe to leave orphaned (cleanup is filed as tech-debt).
 */
export const TAG_CLUSTERS_COLLECTION = "pa-rec-tag-clusters-v2"

/** Firestore collection the cluster rebuild reads from. */
const MATCHING_JOBS_COLLECTION = "matching-jobs"

/** Top-K jobs persisted per cluster doc. Brief override = 50. */
export const DEFAULT_TOP_K_PER_CLUSTER = 50

/** Pagination page size for the rebuild scan. */
const REBUILD_PAGE_SIZE = 500

/** Defensive cap on the rebuild scan to keep CF Gen2 under 60s. */
const REBUILD_MAX_PAGES = 200

/**
 * The 3 sponsorship buckets every cluster falls into. Both job-side
 * (rebuildClusters) and user-side (clusterKeysForUser) derive their bucket
 * from this finite set so cluster ids align mechanically.
 */
export const SPONSORSHIP_BUCKETS = ["sponsor", "no-sponsor", "unknown"] as const
export type SponsorshipBucket = (typeof SPONSORSHIP_BUCKETS)[number]

// ---------------------------------------------------------------------------
// Cluster doc schema (zod) — read-side validation when daily-batch consumes.
// ---------------------------------------------------------------------------

export const TagClusterDocSchema = z.object({
  /** Stable hash id; matches the doc id. */
  clusterId: z.string(),
  /** Canonical industry enum that anchored the cluster (zh+en collapsed). */
  industryEnum: z.string(),
  /**
   * Sponsorship bucket the cluster represents. One of "sponsor",
   * "no-sponsor", "unknown" — matches the SponsorshipBucket type.
   */
  sponsorshipBucket: z.enum(SPONSORSHIP_BUCKETS),
  /** Top-K jobIds, sorted by firstSeenAt desc (highest priority first). */
  jobIds: z.array(z.string()),
  /** Number of buckets matched (informational, not load-bearing). */
  jobCount: z.number().int().nonnegative(),
  /** ISO timestamp of last rebuild. */
  refreshedAt: z.string(),
  /** Idempotency: skip duplicate triggers carrying same runId. */
  lastRebuildRunId: z.string().nullable().optional(),
  /** Optional LLM-summary; future D2/H13 opener may use it. */
  summary: z.string().nullable().optional(),
})
export type TagClusterDoc = z.infer<typeof TagClusterDocSchema>

// ---------------------------------------------------------------------------
// computeClusterId — pure
// ---------------------------------------------------------------------------

/**
 * Compute a stable cluster id from (industryEnum, sponsorshipBucket).
 *
 * Properties:
 *   - Deterministic: same input → same id (across processes, across days).
 *   - Bilingual-safe: relies on industryEnum which is already canonicalized
 *     by the F2 enrichment pipeline (zh + en collapse to same enum value).
 *   - Lowercase + trim normalization to absorb trivial casing/whitespace.
 *   - 12-char hex prefix → 48-bit collision space, plenty for ~30 clusters.
 *
 * Returns "" only when industryEnum is empty (defensive).
 */
export function computeClusterId(
  industryEnum: string,
  sponsorshipBucket: SponsorshipBucket
): string {
  const normIndustry = String(industryEnum ?? "").toLowerCase().trim()
  if (!normIndustry) return ""
  // Defensive: callers should always pass a SponsorshipBucket literal, but
  // narrow at runtime to avoid hashing garbage if caller drifts.
  const bucket: SponsorshipBucket =
    sponsorshipBucket === "sponsor" ||
    sponsorshipBucket === "no-sponsor" ||
    sponsorshipBucket === "unknown"
      ? sponsorshipBucket
      : "unknown"
  const payload = `${normIndustry}|${bucket}`
  return createHash("sha256").update(payload).digest("hex").slice(0, 12)
}

/**
 * Map a job's raw `sponsorship: boolean | null | undefined` field to a
 * SponsorshipBucket. Pure / no I/O.
 */
export function jobSponsorshipBucket(
  jobSponsorship: unknown
): SponsorshipBucket {
  if (jobSponsorship === true) return "sponsor"
  if (jobSponsorship === false) return "no-sponsor"
  return "unknown"
}

/**
 * Map a user's `JobProfile.sponsorship` enum (or absent value) to the
 * cluster buckets that user should fan out into.
 *
 *   "h1b" / "gc" → user wants sponsorship → ["sponsor", "unknown"]
 *   "none"       → user does not want    → ["no-sponsor", "unknown"]
 *   "either" / undefined / null → no preference → all 3 buckets
 *
 * Always includes "unknown" because corpus jobs frequently lack a
 * sponsorship signal and we'd rather over-fetch than miss the user's pool.
 *
 * Pure / no I/O.
 */
export function userSponsorshipBuckets(
  pref: string | null | undefined
): SponsorshipBucket[] {
  if (pref === "h1b" || pref === "gc") return ["sponsor", "unknown"]
  if (pref === "none") return ["no-sponsor", "unknown"]
  // "either" / undefined / null / unknown values → fan out across all buckets
  return ["sponsor", "no-sponsor", "unknown"]
}

/**
 * Compute the (up to N) cluster ids a user belongs to, based on their
 * industry tag set + sponsorship preference. Each industry tag fans out
 * across the user's sponsorship buckets (2 or 3 per industry). We cap at
 * top-3 industry tags so worst case is 3 industries × 3 buckets = 9 reads.
 *
 * Pure / no I/O.
 */
export function clusterKeysForUser(args: {
  industryTags: readonly string[]
  /** User's `JobProfile.sponsorship` enum value (or null/undefined). */
  sponsorship?: string | null
}): string[] {
  const tags = (Array.isArray(args.industryTags) ? args.industryTags : [])
    .filter((t) => typeof t === "string" && t.trim().length > 0)
    .slice(0, 3)
  if (tags.length === 0) return []
  const buckets = userSponsorshipBuckets(args.sponsorship ?? null)
  const ids = new Set<string>()
  for (const tag of tags) {
    for (const bucket of buckets) {
      const id = computeClusterId(tag, bucket)
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

// ---------------------------------------------------------------------------
// rebuildClusters — invoked by D2 Cloud Function
// ---------------------------------------------------------------------------

export type RebuildClustersDeps = {
  db: Firestore
  /** ISO clock; injectable for tests. */
  nowIso?: () => string
  /** Idempotency: when supplied + matches existing lastRebuildRunId, skip writes. */
  runId?: string | null
  /** Top-K cap per cluster. Defaults to 50. */
  topKPerCluster?: number
  log?: (...args: unknown[]) => void
}

export type RebuildClustersOutcome = {
  clusters: number
  jobsBucketed: number
  jobsScanned: number
  pagesRead: number
  skippedDueToIdempotency: number
}

/**
 * Scan active matching-jobs, bucket by (industryEnum × sponsorshipBucket),
 * write top-K per cluster to pa-rec-tag-clusters-v2.
 *
 * Bilingual handling: relies on `industryEnum` (canonicalized) when present;
 * falls back to `industryKey` (legacy schema). Sponsorship bucket is derived
 * from `raw.sponsorship: boolean | null` via `jobSponsorshipBucket`.
 *
 * Idempotency: when `runId` is supplied, each cluster doc skips the write
 * if its `lastRebuildRunId` matches. Counted in `skippedDueToIdempotency`.
 *
 * Read cost: REBUILD_PAGE_SIZE × pagesRead → ~5k reads/day at current corpus.
 * Write cost: ~clusterCount writes (≤30 expected, free tier ample).
 */
export async function rebuildClusters(
  deps: RebuildClustersDeps
): Promise<RebuildClustersOutcome> {
  const log = deps.log ?? (() => {})
  const nowIso = (deps.nowIso ?? (() => new Date().toISOString()))()
  const topK = deps.topKPerCluster ?? DEFAULT_TOP_K_PER_CLUSTER
  const runId = deps.runId ?? null

  // Bucket: clusterId → { industryEnum, sponsorshipBucket, jobs[] }
  type Bucket = {
    industryEnum: string
    sponsorshipBucket: SponsorshipBucket
    // Pre-sorted by firstSeenAt desc as we accumulate; capped at topK.
    jobs: Array<{ id: string; firstSeenAt: string }>
  }
  const buckets = new Map<string, Bucket>()

  let pagesRead = 0
  let jobsScanned = 0
  let lastFirstSeenAt: string | undefined
  // Pagination: orderBy firstSeenAt desc + startAfter cursor. Each loop
  // pulls REBUILD_PAGE_SIZE rows; stop on empty page or REBUILD_MAX_PAGES.
  while (pagesRead < REBUILD_MAX_PAGES) {
    let q = deps.db
      .collection(MATCHING_JOBS_COLLECTION)
      .where("status", "==", "active")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q = (q as any).orderBy("firstSeenAt", "desc")
    if (lastFirstSeenAt !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q = (q as any).startAfter(lastFirstSeenAt)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q = (q as any).limit(REBUILD_PAGE_SIZE)
    const snap = await q.get()
    pagesRead += 1
    if (snap.empty || snap.size === 0) break

    for (const doc of snap.docs) {
      try {
        const raw = doc.data() as Record<string, unknown>
        // industryEnum may be array (canonical schema) OR string (legacy).
        // For clustering we pick the FIRST value of array (most-confident
        // tag) or fall back to industryKey when enum array missing.
        let industryEnum = ""
        if (Array.isArray(raw.industryEnum)) {
          const arr = raw.industryEnum as unknown[]
          const first = arr.find((v) => typeof v === "string" && (v as string).length > 0)
          if (typeof first === "string") industryEnum = first
        } else if (typeof raw.industryEnum === "string") {
          industryEnum = raw.industryEnum
        }
        if (!industryEnum && typeof raw.industryKey === "string") {
          industryEnum = raw.industryKey
        }
        if (!industryEnum) continue // can't cluster a row without an industry signal

        const bucket = jobSponsorshipBucket(raw.sponsorship)
        const id = computeClusterId(industryEnum, bucket)
        if (!id) continue

        const fs = typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : ""
        const b =
          buckets.get(id) ??
          ((): Bucket => {
            const fresh: Bucket = {
              industryEnum: industryEnum.toLowerCase().trim(),
              sponsorshipBucket: bucket,
              jobs: [],
            }
            buckets.set(id, fresh)
            return fresh
          })()
        b.jobs.push({ id: doc.id, firstSeenAt: fs })
        jobsScanned += 1
        lastFirstSeenAt = fs || lastFirstSeenAt
      } catch (err) {
        log("[tag-cluster-rec] dropping_malformed_row", {
          id: doc.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (snap.size < REBUILD_PAGE_SIZE) break
  }

  // Sort each bucket by firstSeenAt desc + truncate to topK.
  for (const bucket of buckets.values()) {
    bucket.jobs.sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt))
    bucket.jobs = bucket.jobs.slice(0, topK)
  }

  // Write each cluster doc, honoring idempotency.
  let clustersWritten = 0
  let jobsBucketed = 0
  let skippedDueToIdempotency = 0
  for (const [clusterId, bucket] of buckets) {
    const ref = deps.db.collection(TAG_CLUSTERS_COLLECTION).doc(clusterId)
    if (runId) {
      try {
        const existing = await ref.get()
        if (existing.exists) {
          const data = existing.data() as Record<string, unknown> | undefined
          const lastRun = data?.lastRebuildRunId
          if (typeof lastRun === "string" && lastRun === runId) {
            skippedDueToIdempotency += 1
            continue
          }
        }
      } catch (err) {
        log("[tag-cluster-rec] idempotency_check_failed", {
          clusterId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const docPayload: TagClusterDoc = {
      clusterId,
      industryEnum: bucket.industryEnum,
      sponsorshipBucket: bucket.sponsorshipBucket,
      jobIds: bucket.jobs.map((j) => j.id),
      jobCount: bucket.jobs.length,
      refreshedAt: nowIso,
      lastRebuildRunId: runId,
      summary: null,
    }
    try {
      await ref.set(docPayload)
      clustersWritten += 1
      jobsBucketed += bucket.jobs.length
    } catch (err) {
      log("[tag-cluster-rec] cluster_write_failed", {
        clusterId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log("[tag-cluster-rec] rebuild_complete", {
    clusters: clustersWritten,
    jobsBucketed,
    jobsScanned,
    pagesRead,
    skippedDueToIdempotency,
  })

  return {
    clusters: clustersWritten,
    jobsBucketed,
    jobsScanned,
    pagesRead,
    skippedDueToIdempotency,
  }
}

// ---------------------------------------------------------------------------
// fetchTopKFromCluster — invoked by daily-batch when paTagClusterRecEnabled
// ---------------------------------------------------------------------------

export type FetchTopKFromClusterDeps = {
  db: Firestore
  log?: (...args: unknown[]) => void
}

export type UserTags = {
  /** Canonical 10-tag list from normalized profile.industryTags. */
  industryTags: readonly string[]
  /**
   * User's sponsorship preference enum from JobProfile.sponsorship —
   * "h1b" | "gc" | "none" | "either". Drives which sponsorship buckets
   * the user fans out into. Optional/null → fan out across all 3 buckets.
   */
  sponsorship?: string | null
  /**
   * User's CV skills — kept for IN-CLUSTER scoring (jaccard fallback when
   * embeddings unavailable). NO LONGER part of the cluster key (Phase 51
   * alignment fix). Optional.
   */
  skills?: readonly string[]
  /** Optional 1536-d user embedding for cosine rerank inside cluster. */
  userEmbedding?: readonly number[] | null
}

/**
 * Fetch top-K MatchingJobs from the cluster cache for a user.
 *
 * Algorithm:
 *   1. computeClusterIds = clusterKeysForUser({industryTags, sponsorship})
 *      — up to 9 (3 industries × 3 buckets); typically 2-6 in practice.
 *   2. For each clusterId: db.collection.doc(clusterId).get() → jobIds[]
 *   3. Union jobIds (dedupe), batch fetch via getAll (or sequential if no
 *      getAll on the Firestore impl)
 *   4. Project rows via projectMatchingJobRow (same shape as queryMatchingJobs)
 *   5. Score: cosine(user, job.embedding) when both present, else jaccard
 *      (user.skills, job.requiredSkills); sort desc; take top K.
 *
 * Returns [] when no cluster doc found OR all clusters empty — daily-batch
 * treats empty as "fall through to legacy queryMatchingJobs path", preserving
 * zero-regression contract when cluster cache is cold.
 *
 * Includes embedding field on returned jobs (mirrors queryMatchingJobs's
 * `includeEmbedding: true` mode) so downstream cosine rerank still has fuel.
 */
export async function fetchTopKFromCluster(
  deps: FetchTopKFromClusterDeps,
  userTags: UserTags,
  k: number
): Promise<MatchingJob[]> {
  const log = deps.log ?? (() => {})
  const clusterIds = clusterKeysForUser({
    industryTags: userTags.industryTags,
    sponsorship: userTags.sponsorship ?? null,
  })
  if (clusterIds.length === 0) {
    log("[tag-cluster-rec] no_cluster_keys_for_user")
    return []
  }

  // 1. Fetch each cluster doc (≤9) and union the jobIds.
  const allIds = new Set<string>()
  for (const cid of clusterIds) {
    try {
      const snap = await deps.db.collection(TAG_CLUSTERS_COLLECTION).doc(cid).get()
      if (!snap.exists) continue
      const raw = snap.data()
      // Best-effort zod parse; tolerate partial.
      const ids = Array.isArray((raw as Record<string, unknown>)?.jobIds)
        ? ((raw as Record<string, unknown>).jobIds as unknown[])
        : []
      for (const id of ids) {
        if (typeof id === "string" && id.length > 0) allIds.add(id)
      }
    } catch (err) {
      log("[tag-cluster-rec] cluster_get_failed", {
        clusterId: cid,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (allIds.size === 0) return []

  // 2. Fetch matching-job docs by id. Sequential get is acceptable at ≤450
  //    rows (9 clusters × top-50). Future enhancement: getAll batching.
  const projected: Array<MatchingJob & { embedding?: number[] | null }> = []
  for (const id of allIds) {
    try {
      const docSnap = await deps.db.collection(MATCHING_JOBS_COLLECTION).doc(id).get()
      if (!docSnap.exists) continue
      const raw = docSnap.data() as Record<string, unknown>
      // Filter active here (defense-in-depth: cluster might be 1-day stale
      // and a job could have been deactivated since rebuild).
      if (raw.status !== "active") continue
      const m = projectMatchingJobRow(id, raw)
      const validated = MatchingJobSchema.parse(m) as MatchingJob & {
        embedding?: number[] | null
      }
      const e = raw.embedding
      if (Array.isArray(e) && e.every((n) => typeof n === "number")) {
        validated.embedding = e as number[]
      } else {
        validated.embedding = null
      }
      projected.push(validated)
    } catch (err) {
      log("[tag-cluster-rec] cluster_member_fetch_failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (projected.length === 0) return []

  // 3. Score within cluster: cosine when user-emb + job-emb present + same
  //    dim, else jaccard(user.skills, job.requiredSkills). Sort desc, take k.
  const userEmb = userTags.userEmbedding ?? null
  const userSkills = (Array.isArray(userTags.skills) ? userTags.skills : []) as string[]
  const scored = projected.map((j) => {
    let score = 0
    if (userEmb && Array.isArray(j.embedding) && j.embedding.length === userEmb.length) {
      score = cosineSimilarity(userEmb, j.embedding)
    } else if (Array.isArray(j.requiredSkills) && j.requiredSkills.length > 0) {
      score = jaccardOverlap([...userSkills], j.requiredSkills)
    }
    return { j, s: score }
  })
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s
    return (b.j.firstSeenAt ?? "").localeCompare(a.j.firstSeenAt ?? "")
  })
  // Strip embedding when daily-batch's pipeline expects vanilla MatchingJob;
  // but downstream queryMatchingJobs path also surfaces embedding when
  // includeEmbedding=true. We keep it (forward-compat — downstream cosine
  // rerank picks it up).
  return scored.slice(0, Math.max(1, k)).map((x) => x.j)
}
