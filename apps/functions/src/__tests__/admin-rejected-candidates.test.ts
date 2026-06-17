import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import { runAdminRejectedCandidates } from "../admin-rejected-candidates.js"
import { reevaluateCandidateTier, setGlobalCandidateTierManual, applyGlobalCandidateTier } from "../candidate-tier.js"

function gt(tier: string, reusable: boolean) {
  return { globalCandidateTier: { tier, source: "recruiter", reusable, updatedAt: "2026-06-16T00:00:00.000Z", rejectionCount: 1 } }
}

async function seed(mfs: MockFirestore) {
  await mfs.collection("pa-users").doc("cand-1").set({ id: "cand-1", displayName: "Strong One", ...gt("tier_1", true) })
  await mfs.collection("pa-users").doc("cand-2").set({ id: "cand-2", displayName: "Hard No", ...gt("tier_3", false) })
  await mfs.collection("pa-users").doc("cand-3").set({ id: "cand-3", displayName: "Never Rejected" }) // no tier
  await mfs.collection("pa-users").doc("cand-4").set({ id: "cand-4", displayName: "Reusable Two", ...gt("tier_2", true) })
}

describe("runAdminRejectedCandidates", () => {
  it("returns only tiered candidates with correct counts", async () => {
    const mfs = new MockFirestore()
    await seed(mfs)
    const res = await runAdminRejectedCandidates({ reusableOnly: false, includeTest: false, limit: 200 }, { db: asFirestore(mfs) })
    assert.equal(res.rows.length, 3) // cand-3 (no tier) excluded
    assert.equal(res.counts.total, 3)
    assert.equal(res.counts.tier_1, 1)
    assert.equal(res.counts.tier_2, 1)
    assert.equal(res.counts.tier_3, 1)
    assert.equal(res.counts.reusable, 2)
  })

  it("filters by tier", async () => {
    const mfs = new MockFirestore()
    await seed(mfs)
    const res = await runAdminRejectedCandidates({ tier: "tier_1", reusableOnly: false, includeTest: false, limit: 200 }, { db: asFirestore(mfs) })
    assert.equal(res.rows.length, 1)
    assert.equal(res.rows[0]!.candidateId, "cand-1")
    // counts still reflect the full tiered population
    assert.equal(res.counts.total, 3)
  })

  it("filters reusableOnly (tier_1 + tier_2)", async () => {
    const mfs = new MockFirestore()
    await seed(mfs)
    const res = await runAdminRejectedCandidates({ reusableOnly: true, includeTest: false, limit: 200 }, { db: asFirestore(mfs) })
    assert.equal(res.rows.length, 2)
    assert.ok(res.rows.every((r) => r.reusable))
  })
})

describe("reevaluateCandidateTier", () => {
  it("suggests the best tier across the candidate's rejection evidence", async () => {
    const mfs = new MockFirestore()
    const now = () => "2026-06-16T00:00:00.000Z"
    // two rejections: tier_3 (job A) and tier_1 (job B) → best = tier_1
    await applyGlobalCandidateTier({ candidateId: "c", tier: "tier_3", source: "prescreen", jobId: "A" }, { db: asFirestore(mfs), now })
    await applyGlobalCandidateTier({ candidateId: "c", tier: "tier_2", source: "recruiter", jobId: "B", aiSuggestedTier: "tier_1" }, { db: asFirestore(mfs), now })

    const res = await reevaluateCandidateTier("c", { db: asFirestore(mfs) })
    assert.equal(res.currentGlobalTier, "tier_2") // best-wins of committed tiers tier_3,tier_2
    assert.equal(res.suggestedTier, "tier_1") // includes the AI suggestion tier_1 on event B
    assert.equal(res.eventsConsidered, 2)
  })

  it("manual set overrides best-wins with operator authority + writes correction", async () => {
    const mfs = new MockFirestore()
    const now = () => "2026-06-16T00:00:00.000Z"
    await applyGlobalCandidateTier({ candidateId: "c2", tier: "tier_1", source: "recruiter" }, { db: asFirestore(mfs), now })
    const res = await setGlobalCandidateTierManual({ candidateId: "c2", tier: "tier_3", actor: "op@wekruit.com" }, { db: asFirestore(mfs), now })
    assert.equal(res.changed, true)
    const snap = await mfs.collection("pa-users").doc("c2").get()
    const stored = (snap.data() as Record<string, unknown>).globalCandidateTier as Record<string, unknown>
    assert.equal(stored.tier, "tier_3") // operator override beat best-wins
    assert.equal(stored.humanConfirmed, true)
    assert.equal((await mfs.collection("pa-correction-events").get()).size, 1)
  })
})
