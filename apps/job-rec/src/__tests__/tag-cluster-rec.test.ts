/**
 * v1.5 Stream-G.2 / Phase 51 — tag-cluster-rec unit tests.
 *
 * Phase 51 post-ship alignment fix (2026-05-02): switched cluster key from
 * (industryEnum, top-3 skills) to (industryEnum, sponsorshipBucket). Tests
 * 1-7 rewritten for the new key algorithm; tests 8-11 added to lock down
 * sponsorship-bucket fanout behavior.
 *
 * Coverage matrix:
 *   1. computeClusterId determinism (same (industry, bucket) → same id)
 *   2. computeClusterId rejects empty industry
 *   3. clusterKeysForUser fans industries × sponsorship buckets
 *   4. rebuildClusters writes top-K cluster docs from active corpus
 *   5. rebuildClusters honors idempotency-by-runId (skip on match)
 *   6. fetchTopKFromCluster returns [] on cold cache (allowing fallback)
 *   7. fetchTopKFromCluster scores cosine when embeddings present, jaccard otherwise
 *   8. NEW — user(sponsorship="h1b") hits the sponsor cluster
 *   9. NEW — user(sponsorship="none") hits the no-sponsor cluster
 *  10. NEW — user(sponsorship undefined) sees all 3 sponsorship buckets per industry
 *  11. NEW — cross-industry user (≥2 industryTags) sees merged candidate keys
 */

import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "./mock-firestore.js"
import {
  computeClusterId,
  clusterKeysForUser,
  rebuildClusters,
  fetchTopKFromCluster,
  jobSponsorshipBucket,
  userSponsorshipBuckets,
  TAG_CLUSTERS_COLLECTION,
} from "../tag-cluster-rec.js"

// ---------------------------------------------------------------------------
// Test 1 — computeClusterId determinism
// ---------------------------------------------------------------------------

test("computeClusterId: same (industry, bucket) → same id; casing/whitespace normalized", () => {
  const a = computeClusterId("tech_software", "sponsor")
  const b = computeClusterId("tech_software", "sponsor")
  assert.equal(a, b, "deterministic for identical input")
  assert.equal(a.length, 12, "id is 12-char hex prefix")

  // Different industry → different id
  const c = computeClusterId("fintech_finance", "sponsor")
  assert.notEqual(a, c, "different industry produces different id")

  // Different bucket → different id
  const d = computeClusterId("tech_software", "no-sponsor")
  assert.notEqual(a, d, "different bucket produces different id")

  // All 3 buckets distinct
  const u = computeClusterId("tech_software", "unknown")
  assert.notEqual(a, u)
  assert.notEqual(d, u)

  // Casing + whitespace normalization on industry
  const e = computeClusterId(" Tech_Software ", "sponsor")
  assert.equal(e, a, "industry casing/whitespace are normalized")
})

// ---------------------------------------------------------------------------
// Test 2 — computeClusterId edge cases
// ---------------------------------------------------------------------------

test("computeClusterId: empty industry returns empty string; bucket coerced safely", () => {
  assert.equal(computeClusterId("", "sponsor"), "")
  assert.equal(computeClusterId("   ", "no-sponsor"), "")

  // Non-bucket strings funneled to "unknown" — defensive coercion.
  // (TS layer already prevents this; runtime guard is belt+suspenders.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drift = computeClusterId("tech_software", "garbage" as any)
  const safe = computeClusterId("tech_software", "unknown")
  assert.equal(drift, safe, "unknown bucket value coerces to 'unknown'")
})

// ---------------------------------------------------------------------------
// Test 3 — clusterKeysForUser
// ---------------------------------------------------------------------------

test("clusterKeysForUser: empty industry tags → []", () => {
  assert.deepEqual(
    clusterKeysForUser({ industryTags: [], sponsorship: "h1b" }),
    []
  )
})

// ---------------------------------------------------------------------------
// Test 4 — rebuildClusters end-to-end
// ---------------------------------------------------------------------------

test("rebuildClusters: buckets active jobs by (industryEnum, sponsorshipBucket) → writes pa-rec-tag-clusters-v2", async () => {
  const mfs = new MockFirestore()
  // Seed 4 active jobs:
  //   j1: tech, sponsorship=true  → bucket=sponsor
  //   j2: tech, sponsorship=true  → bucket=sponsor (same cluster as j1)
  //   j3: tech, sponsorship=false → bucket=no-sponsor (different cluster)
  //   j4: fintech, sponsorship=null → bucket=unknown (different cluster)
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech_software",
    sponsorship: true,
    firstSeenAt: "2026-05-01",
    lastSeenAt: "2026-05-01",
  })
  await mfs.collection("matching-jobs").doc("j2").set({
    status: "active",
    industryKey: "tech_software",
    sponsorship: true,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
  })
  await mfs.collection("matching-jobs").doc("j3").set({
    status: "active",
    industryKey: "tech_software",
    sponsorship: false,
    firstSeenAt: "2026-04-29",
    lastSeenAt: "2026-04-29",
  })
  await mfs.collection("matching-jobs").doc("j4").set({
    status: "active",
    industryKey: "fintech_finance",
    // sponsorship omitted → null/unknown bucket
    firstSeenAt: "2026-04-28",
    lastSeenAt: "2026-04-28",
  })

  const out = await rebuildClusters({
    db: asFirestore(mfs),
    nowIso: () => "2026-05-02T00:00:00Z",
    runId: "run-1",
  })
  assert.equal(out.clusters, 3, "3 distinct clusters: tech-sponsor, tech-no-sponsor, fintech-unknown")
  assert.equal(out.jobsBucketed, 4)
  // Cluster collection has 3 docs in the v2 collection.
  const writes = mfs.writeLog.filter((w) => w.path === TAG_CLUSTERS_COLLECTION)
  assert.equal(writes.length, 3)
  // Confirm we're writing to the v2 collection (Phase 51 alignment fix).
  assert.equal(TAG_CLUSTERS_COLLECTION, "pa-rec-tag-clusters-v2")
  // tech-sponsor cluster has both j1 and j2, ordered by firstSeenAt desc.
  const techSponsorCluster = writes.find((w) => {
    const ids = w.data.jobIds as string[]
    return ids.includes("j1") && ids.includes("j2")
  })
  assert.ok(techSponsorCluster, "tech-sponsor cluster has both j1 and j2")
  assert.equal(techSponsorCluster.data.lastRebuildRunId, "run-1")
  assert.equal(techSponsorCluster.data.sponsorshipBucket, "sponsor")
  assert.equal(techSponsorCluster.data.industryEnum, "tech_software")
  assert.deepEqual(
    techSponsorCluster.data.jobIds,
    ["j1", "j2"],
    "ordered by firstSeenAt desc"
  )
})

// ---------------------------------------------------------------------------
// Test 5 — rebuildClusters idempotency
// ---------------------------------------------------------------------------

test("rebuildClusters: idempotent by runId — re-run with same runId skips writes", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech_software",
    sponsorship: true,
    firstSeenAt: "2026-05-01",
    lastSeenAt: "2026-05-01",
  })

  const first = await rebuildClusters({
    db: asFirestore(mfs),
    nowIso: () => "2026-05-02T00:00:00Z",
    runId: "run-X",
  })
  assert.equal(first.clusters, 1)
  assert.equal(first.skippedDueToIdempotency, 0)

  // Second call same runId — should noop on writes.
  const second = await rebuildClusters({
    db: asFirestore(mfs),
    nowIso: () => "2026-05-02T01:00:00Z",
    runId: "run-X",
  })
  assert.equal(second.clusters, 0)
  assert.equal(second.skippedDueToIdempotency, 1)

  // Third call NEW runId — writes fresh.
  const third = await rebuildClusters({
    db: asFirestore(mfs),
    nowIso: () => "2026-05-02T02:00:00Z",
    runId: "run-Y",
  })
  assert.equal(third.clusters, 1)
  assert.equal(third.skippedDueToIdempotency, 0)
})

// ---------------------------------------------------------------------------
// Test 6 — fetchTopKFromCluster cold cache
// ---------------------------------------------------------------------------

test("fetchTopKFromCluster: returns [] when cluster doc missing (allows daily-batch fallback)", async () => {
  const mfs = new MockFirestore()
  const out = await fetchTopKFromCluster(
    { db: asFirestore(mfs) },
    {
      industryTags: ["tech_software"],
      sponsorship: "h1b",
      skills: ["python", "ts"],
      userEmbedding: null,
    },
    10
  )
  assert.deepEqual(out, [], "cold cache → empty result so daily-batch falls through")
})

// ---------------------------------------------------------------------------
// Test 7 — fetchTopKFromCluster cosine + jaccard scoring
// ---------------------------------------------------------------------------

test("fetchTopKFromCluster: scores cosine when embeddings present, jaccard otherwise; ranks desc", async () => {
  const mfs = new MockFirestore()
  // Build a sponsor cluster doc directly with 2 jobIds.
  const clusterId = computeClusterId("tech_software", "sponsor")
  await mfs.collection(TAG_CLUSTERS_COLLECTION).doc(clusterId).set({
    clusterId,
    industryEnum: "tech_software",
    sponsorshipBucket: "sponsor",
    jobIds: ["jA", "jB"],
    jobCount: 2,
    refreshedAt: "2026-05-02T00:00:00Z",
    lastRebuildRunId: "run-1",
    summary: null,
  })
  // jA: aligned embedding [1,0,0] (cosine 1.0 with user)
  await mfs.collection("matching-jobs").doc("jA").set({
    status: "active",
    industryKey: "tech_software",
    requiredSkills: ["python", "ts"],
    sponsorship: true,
    firstSeenAt: "2026-05-01",
    lastSeenAt: "2026-05-01",
    embedding: [1, 0, 0],
    companyName: "Acme",
    roleTitle: "SWE",
    locationRaw: "Remote",
    primaryUrl: "https://j/A",
    industry: "tech",
  })
  // jB: orthogonal embedding [0,1,0] (cosine 0.0)
  await mfs.collection("matching-jobs").doc("jB").set({
    status: "active",
    industryKey: "tech_software",
    requiredSkills: ["sql"],
    sponsorship: true,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    embedding: [0, 1, 0],
    companyName: "Beta",
    roleTitle: "DBA",
    locationRaw: "Remote",
    primaryUrl: "https://j/B",
    industry: "tech",
  })

  // With user embedding [1,0,0] → jA cosine 1.0, jB cosine 0.0 → jA first.
  const out = await fetchTopKFromCluster(
    { db: asFirestore(mfs) },
    {
      industryTags: ["tech_software"],
      sponsorship: "h1b",
      skills: ["python", "ts"],
      userEmbedding: [1, 0, 0],
    },
    10
  )
  assert.equal(out.length, 2)
  assert.equal(out[0]!.id, "jA", "cosine winner ranks first")
  assert.equal(out[1]!.id, "jB")

  // Without user embedding → jaccard kicks in. user.skills [python,ts] vs
  // jA.requiredSkills [python,ts] = 1.0 ; jB [sql] = 0 → jA still first.
  const out2 = await fetchTopKFromCluster(
    { db: asFirestore(mfs) },
    {
      industryTags: ["tech_software"],
      sponsorship: "h1b",
      skills: ["python", "ts"],
      userEmbedding: null,
    },
    10
  )
  assert.equal(out2[0]!.id, "jA")
})

// ---------------------------------------------------------------------------
// Test 8 — sponsor user hits sponsor cluster (Phase 51 alignment fix)
// ---------------------------------------------------------------------------

test("fetchTopKFromCluster: user(sponsorship='h1b') hits the sponsor cluster", async () => {
  const mfs = new MockFirestore()

  // Job j1 is in the SPONSOR cluster. Job j2 is in the NO-SPONSOR cluster.
  // We only seed the SPONSOR cluster's doc; user('h1b') should pull j1
  // (and may also probe an "unknown" cluster which is empty → still resolves).
  const sponsorId = computeClusterId("tech_software", "sponsor")
  await mfs.collection(TAG_CLUSTERS_COLLECTION).doc(sponsorId).set({
    clusterId: sponsorId,
    industryEnum: "tech_software",
    sponsorshipBucket: "sponsor",
    jobIds: ["j1"],
    jobCount: 1,
    refreshedAt: "2026-05-02T00:00:00Z",
    lastRebuildRunId: "run-1",
    summary: null,
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech_software",
    sponsorship: true,
    firstSeenAt: "2026-05-01",
    lastSeenAt: "2026-05-01",
    companyName: "Acme",
    roleTitle: "SWE",
    locationRaw: "SF",
    primaryUrl: "https://j/1",
    industry: "tech",
    requiredSkills: ["python"],
  })

  const out = await fetchTopKFromCluster(
    { db: asFirestore(mfs) },
    {
      industryTags: ["tech_software"],
      sponsorship: "h1b",
      skills: ["python"],
      userEmbedding: null,
    },
    10
  )
  assert.equal(out.length, 1, "h1b user pulls 1 sponsor-cluster job")
  assert.equal(out[0]!.id, "j1")
})

// ---------------------------------------------------------------------------
// Test 9 — no-sponsor user hits no-sponsor cluster
// ---------------------------------------------------------------------------

test("fetchTopKFromCluster: user(sponsorship='none') hits the no-sponsor cluster, NOT the sponsor cluster", async () => {
  const mfs = new MockFirestore()

  // Build BOTH a sponsor cluster (with j1) and a no-sponsor cluster (with j2).
  // user('none') should fan out to no-sponsor + unknown buckets, NEVER hit
  // the sponsor cluster.
  const sponsorId = computeClusterId("tech_software", "sponsor")
  const noSponsorId = computeClusterId("tech_software", "no-sponsor")
  await mfs.collection(TAG_CLUSTERS_COLLECTION).doc(sponsorId).set({
    clusterId: sponsorId,
    industryEnum: "tech_software",
    sponsorshipBucket: "sponsor",
    jobIds: ["j1-sponsor"],
    jobCount: 1,
    refreshedAt: "2026-05-02T00:00:00Z",
    lastRebuildRunId: "run-1",
    summary: null,
  })
  await mfs.collection(TAG_CLUSTERS_COLLECTION).doc(noSponsorId).set({
    clusterId: noSponsorId,
    industryEnum: "tech_software",
    sponsorshipBucket: "no-sponsor",
    jobIds: ["j2-no-sponsor"],
    jobCount: 1,
    refreshedAt: "2026-05-02T00:00:00Z",
    lastRebuildRunId: "run-1",
    summary: null,
  })
  await mfs.collection("matching-jobs").doc("j1-sponsor").set({
    status: "active",
    industryKey: "tech_software",
    sponsorship: true,
    firstSeenAt: "2026-05-01",
    lastSeenAt: "2026-05-01",
    companyName: "VisaCorp",
    roleTitle: "SWE",
    locationRaw: "SF",
    primaryUrl: "https://j/sp",
    industry: "tech",
  })
  await mfs.collection("matching-jobs").doc("j2-no-sponsor").set({
    status: "active",
    industryKey: "tech_software",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    companyName: "USOnly",
    roleTitle: "SWE",
    locationRaw: "SF",
    primaryUrl: "https://j/ns",
    industry: "tech",
  })

  const out = await fetchTopKFromCluster(
    { db: asFirestore(mfs) },
    {
      industryTags: ["tech_software"],
      sponsorship: "none",
      skills: [],
      userEmbedding: null,
    },
    10
  )
  const ids = out.map((j) => j.id)
  assert.ok(ids.includes("j2-no-sponsor"), "no-sponsor cluster member returned")
  assert.ok(!ids.includes("j1-sponsor"), "sponsor cluster member EXCLUDED for sponsorship='none' user")
})

// ---------------------------------------------------------------------------
// Test 10 — unknown / undefined sponsorship → fan out across all 3 buckets
// ---------------------------------------------------------------------------

test("clusterKeysForUser: user with undefined sponsorship sees all 3 buckets per industry tag", () => {
  const undef = clusterKeysForUser({
    industryTags: ["tech_software"],
    sponsorship: undefined,
  })
  // 1 industry × 3 buckets = 3 distinct cluster keys
  assert.equal(undef.length, 3, "undefined sponsorship → 3 candidate clusters")

  // "either" enum behaves the same way
  const either = clusterKeysForUser({
    industryTags: ["tech_software"],
    sponsorship: "either",
  })
  assert.equal(either.length, 3)
  // Verify the 3 keys are exactly (sponsor, no-sponsor, unknown) clusters.
  const expected = new Set([
    computeClusterId("tech_software", "sponsor"),
    computeClusterId("tech_software", "no-sponsor"),
    computeClusterId("tech_software", "unknown"),
  ])
  for (const k of either) {
    assert.ok(expected.has(k), `key ${k} matches one of the 3 expected sponsorship buckets`)
  }

  // h1b/gc users see 2 buckets (their preferred + unknown fallback)
  const h1b = clusterKeysForUser({
    industryTags: ["tech_software"],
    sponsorship: "h1b",
  })
  assert.equal(h1b.length, 2, "h1b user → sponsor + unknown buckets")
  const none = clusterKeysForUser({
    industryTags: ["tech_software"],
    sponsorship: "none",
  })
  assert.equal(none.length, 2, "none user → no-sponsor + unknown buckets")

  // jobSponsorshipBucket helper map
  assert.equal(jobSponsorshipBucket(true), "sponsor")
  assert.equal(jobSponsorshipBucket(false), "no-sponsor")
  assert.equal(jobSponsorshipBucket(null), "unknown")
  assert.equal(jobSponsorshipBucket(undefined), "unknown")
  assert.equal(jobSponsorshipBucket("anything"), "unknown")

  // userSponsorshipBuckets helper map
  assert.deepEqual(userSponsorshipBuckets("h1b"), ["sponsor", "unknown"])
  assert.deepEqual(userSponsorshipBuckets("gc"), ["sponsor", "unknown"])
  assert.deepEqual(userSponsorshipBuckets("none"), ["no-sponsor", "unknown"])
  assert.deepEqual(userSponsorshipBuckets("either"), ["sponsor", "no-sponsor", "unknown"])
  assert.deepEqual(userSponsorshipBuckets(null), ["sponsor", "no-sponsor", "unknown"])
})

// ---------------------------------------------------------------------------
// Test 11 — cross-industry user sees merged keys (industries × buckets)
// ---------------------------------------------------------------------------

test("clusterKeysForUser: cross-industry user (≥2 industryTags) sees merged candidate keys", () => {
  // 2 industries × 3 buckets ("either") = 6 distinct cluster keys
  const cross2 = clusterKeysForUser({
    industryTags: ["tech_software", "fintech_finance"],
    sponsorship: "either",
  })
  assert.equal(cross2.length, 6, "2 industries × 3 buckets = 6 keys")

  // Cap at 3 industries (slice). 3 industries × 3 buckets = 9 keys.
  const cross3 = clusterKeysForUser({
    industryTags: [
      "tech_software",
      "fintech_finance",
      "ai_ml",
      "consumer_retail", // beyond cap, dropped
    ],
    sponsorship: "either",
  })
  assert.equal(cross3.length, 9, "3 industries × 3 buckets = 9 keys (4th industry dropped by cap)")

  // 2 industries × 2 buckets ("h1b") = 4 distinct cluster keys
  const cross2h1b = clusterKeysForUser({
    industryTags: ["tech_software", "fintech_finance"],
    sponsorship: "h1b",
  })
  assert.equal(cross2h1b.length, 4, "2 industries × 2 buckets (h1b → sponsor+unknown) = 4 keys")
})
