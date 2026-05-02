/**
 * v1.5 Stream-G.2 / Phase 51 — tag-cluster-rec unit tests.
 *
 * Coverage matrix:
 *   1. computeClusterId determinism (same input → same id; order-independent skills)
 *   2. computeClusterId rejects empty industry
 *   3. clusterKeysForUser returns up to 3 distinct keys
 *   4. rebuildClusters writes top-K cluster docs from active corpus
 *   5. rebuildClusters honors idempotency-by-runId (skip on match)
 *   6. fetchTopKFromCluster returns [] on cold cache (allowing fallback)
 *   7. fetchTopKFromCluster scores cosine when embeddings present, jaccard otherwise
 */

import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "./mock-firestore.js"
import {
  computeClusterId,
  clusterKeysForUser,
  rebuildClusters,
  fetchTopKFromCluster,
  TAG_CLUSTERS_COLLECTION,
} from "../tag-cluster-rec.js"

// ---------------------------------------------------------------------------
// Test 1 — computeClusterId determinism
// ---------------------------------------------------------------------------

test("computeClusterId: same (industry, skills) → same id; skill order doesn't matter", () => {
  const a = computeClusterId("tech_software", ["typescript", "react", "node"])
  const b = computeClusterId("tech_software", ["node", "react", "typescript"])
  assert.equal(a, b, "skills order should not affect id")
  assert.equal(a.length, 12, "id is 12-char hex prefix")

  const c = computeClusterId("fintech_finance", ["typescript", "react", "node"])
  assert.notEqual(a, c, "different industry should produce different id")

  // Trim + casing normalization
  const d = computeClusterId(" Tech_Software ", ["TypeScript", "React", "Node"])
  assert.equal(d, a, "casing/whitespace are normalized")
})

// ---------------------------------------------------------------------------
// Test 2 — computeClusterId edge cases
// ---------------------------------------------------------------------------

test("computeClusterId: empty industry returns empty string", () => {
  assert.equal(computeClusterId("", ["a", "b", "c"]), "")
  assert.equal(computeClusterId("   ", ["a"]), "")
  // Empty skills is OK — we just hash industry alone.
  const id = computeClusterId("tech_software", [])
  assert.equal(id.length, 12)
})

// ---------------------------------------------------------------------------
// Test 3 — clusterKeysForUser
// ---------------------------------------------------------------------------

test("clusterKeysForUser: returns one key per industry tag (cap 3), deduped", () => {
  const keys = clusterKeysForUser({
    industryTags: ["tech_software", "ai_ml", "fintech_finance", "manufacturing_industrial"],
    topSkills: ["python", "ml"],
  })
  assert.equal(keys.length, 3, "industry tag cap = 3")
  // Each key is a 12-char hex prefix.
  for (const k of keys) assert.equal(k.length, 12)

  // Empty industries → empty result.
  assert.deepEqual(
    clusterKeysForUser({ industryTags: [], topSkills: ["x"] }),
    []
  )
})

// ---------------------------------------------------------------------------
// Test 4 — rebuildClusters end-to-end
// ---------------------------------------------------------------------------

test("rebuildClusters: buckets active jobs by (industryEnum, top-3 skills) → writes pa-rec-tag-clusters", async () => {
  const mfs = new MockFirestore()
  // Seed 3 active jobs: 2 share (tech, [python, ts]); 1 distinct (fintech, [sql]).
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech_software",
    requiredSkills: ["python", "typescript"],
    firstSeenAt: "2026-05-01",
  })
  await mfs.collection("matching-jobs").doc("j2").set({
    status: "active",
    industryKey: "tech_software",
    requiredSkills: ["typescript", "python"], // same set, different order
    firstSeenAt: "2026-04-30",
  })
  await mfs.collection("matching-jobs").doc("j3").set({
    status: "active",
    industryKey: "fintech_finance",
    requiredSkills: ["sql"],
    firstSeenAt: "2026-04-29",
  })

  const out = await rebuildClusters({
    db: asFirestore(mfs),
    nowIso: () => "2026-05-02T00:00:00Z",
    runId: "run-1",
  })
  assert.equal(out.clusters, 2, "2 distinct clusters written")
  assert.equal(out.jobsBucketed, 3)
  // Cluster collection has 2 docs.
  const writes = mfs.writeLog.filter((w) => w.path === TAG_CLUSTERS_COLLECTION)
  assert.equal(writes.length, 2)
  // Each doc carries lastRebuildRunId + jobIds in firstSeenAt-desc order.
  const techCluster = writes.find((w) => {
    const ids = w.data.jobIds as string[]
    return ids.includes("j1") && ids.includes("j2")
  })
  assert.ok(techCluster, "tech cluster has both j1 and j2")
  assert.equal(techCluster.data.lastRebuildRunId, "run-1")
  assert.deepEqual(
    techCluster.data.jobIds,
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
    requiredSkills: ["python"],
    firstSeenAt: "2026-05-01",
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
  // Build a cluster doc directly with 2 jobIds.
  const clusterId = computeClusterId("tech_software", ["python", "ts"])
  await mfs.collection(TAG_CLUSTERS_COLLECTION).doc(clusterId).set({
    clusterId,
    industryEnum: "tech_software",
    topSkills: ["python", "ts"],
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
    firstSeenAt: "2026-05-01",
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
    firstSeenAt: "2026-04-30",
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
      skills: ["python", "ts"],
      userEmbedding: null,
    },
    10
  )
  assert.equal(out2[0]!.id, "jA")
})
