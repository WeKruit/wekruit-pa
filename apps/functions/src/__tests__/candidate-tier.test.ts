import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import { applyGlobalCandidateTier } from "../candidate-tier.js"

const NOW = "2026-06-16T12:00:00.000Z"

function deps(mfs: MockFirestore) {
  return { db: asFirestore(mfs), now: () => NOW }
}

async function readUser(mfs: MockFirestore, id: string): Promise<Record<string, unknown>> {
  const snap = await mfs.collection("pa-users").doc(id).get()
  return (snap.data() ?? {}) as Record<string, unknown>
}

describe("applyGlobalCandidateTier", () => {
  it("stamps a global tier + writes a ledger row on first rejection", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("cand-1").set({ id: "cand-1" })

    const res = await applyGlobalCandidateTier(
      { candidateId: "cand-1", tier: "tier_2", source: "recruiter", jobId: "job-a", reason: "missing skill" },
      deps(mfs),
    )
    assert.equal(res.globalTier, "tier_2")
    assert.equal(res.globalChanged, true)

    const u = await readUser(mfs, "cand-1")
    const gt = u.globalCandidateTier as Record<string, unknown>
    assert.equal(gt.tier, "tier_2")
    assert.equal(gt.reusable, true)
    assert.equal(gt.rejectionCount, 1)
    assert.equal(gt.source, "recruiter")

    const ledger = await mfs.collection("pa-candidate-tier-events").get()
    assert.equal(ledger.size, 1)
    assert.equal((ledger.docs[0]!.data() as Record<string, unknown>).tier, "tier_2")
  })

  it("best-wins: a later tier_1 upgrades a tier_3 candidate", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("cand-2").set({ id: "cand-2" })
    await applyGlobalCandidateTier({ candidateId: "cand-2", tier: "tier_3", source: "prescreen", jobId: "j1" }, deps(mfs))
    const res = await applyGlobalCandidateTier(
      { candidateId: "cand-2", tier: "tier_1", source: "recruiter", jobId: "j2" },
      deps(mfs),
    )
    assert.equal(res.globalTier, "tier_1")
    const gt = (await readUser(mfs, "cand-2")).globalCandidateTier as Record<string, unknown>
    assert.equal(gt.tier, "tier_1")
    assert.equal(gt.source, "recruiter") // source follows the winning tier
    assert.equal(gt.rejectionCount, 2)
    const ledger = await mfs.collection("pa-candidate-tier-events").get()
    assert.equal(ledger.size, 2) // per-role record per rejection
  })

  it("best-wins: a later tier_3 does NOT downgrade a tier_1 candidate", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("cand-3").set({ id: "cand-3" })
    await applyGlobalCandidateTier({ candidateId: "cand-3", tier: "tier_1", source: "recruiter" }, deps(mfs))
    const res = await applyGlobalCandidateTier({ candidateId: "cand-3", tier: "tier_3", source: "prescreen" }, deps(mfs))
    assert.equal(res.globalTier, "tier_1")
    const gt = (await readUser(mfs, "cand-3")).globalCandidateTier as Record<string, unknown>
    assert.equal(gt.source, "recruiter") // kept — tier_1 still wins
  })

  it("writes a correction event only on a genuine human override of the AI", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("cand-4").set({ id: "cand-4" })
    // operator overrides AI tier_3 → tier_1
    const res = await applyGlobalCandidateTier(
      { candidateId: "cand-4", tier: "tier_1", source: "prescreen", aiSuggestedTier: "tier_3", humanConfirmed: true },
      deps(mfs),
    )
    assert.equal(res.wroteCorrection, true)
    const corrections = await mfs.collection("pa-correction-events").get()
    assert.equal(corrections.size, 1)
    const gt = (await readUser(mfs, "cand-4")).globalCandidateTier as Record<string, unknown>
    assert.equal(gt.humanConfirmed, true)
  })

  it("no correction event when operator agrees with the AI suggestion", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-users").doc("cand-5").set({ id: "cand-5" })
    const res = await applyGlobalCandidateTier(
      { candidateId: "cand-5", tier: "tier_2", source: "prescreen", aiSuggestedTier: "tier_2", humanConfirmed: true },
      deps(mfs),
    )
    assert.equal(res.wroteCorrection, false)
    assert.equal((await mfs.collection("pa-correction-events").get()).size, 0)
  })
})
