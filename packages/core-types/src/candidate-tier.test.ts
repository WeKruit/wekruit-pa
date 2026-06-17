import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  bestTier,
  reconcileGlobalTier,
  isReusableTier,
  tierRank,
  suggestTierFromRecruiterAi,
  suggestTierFromPrescreen,
  GlobalCandidateTierSchema,
} from "./candidate-tier.js"

describe("tier ordering (tier_1 best)", () => {
  it("ranks tier_1 > tier_2 > tier_3", () => {
    assert.ok(tierRank("tier_1") > tierRank("tier_2"))
    assert.ok(tierRank("tier_2") > tierRank("tier_3"))
  })
  it("bestTier picks the more reusable", () => {
    assert.equal(bestTier("tier_3", "tier_1"), "tier_1")
    assert.equal(bestTier("tier_2", "tier_3"), "tier_2")
    assert.equal(bestTier("tier_1", "tier_1"), "tier_1")
  })
  it("isReusableTier: tier_1/tier_2 yes, tier_3 no", () => {
    assert.equal(isReusableTier("tier_1"), true)
    assert.equal(isReusableTier("tier_2"), true)
    assert.equal(isReusableTier("tier_3"), false)
  })
})

describe("reconcileGlobalTier (best-wins)", () => {
  it("takes incoming when no current", () => {
    assert.equal(reconcileGlobalTier(undefined, "tier_2"), "tier_2")
    assert.equal(reconcileGlobalTier(null, "tier_3"), "tier_3")
  })
  it("a tier_1 rejection upgrades a previously tier_3 candidate", () => {
    assert.equal(reconcileGlobalTier("tier_3", "tier_1"), "tier_1")
  })
  it("a later tier_3 does NOT downgrade a tier_1 candidate", () => {
    assert.equal(reconcileGlobalTier("tier_1", "tier_3"), "tier_1")
  })
})

describe("suggestTierFromRecruiterAi", () => {
  it("advance/borderline → tier_1", () => {
    assert.equal(suggestTierFromRecruiterAi("advance", 2), "tier_1")
    assert.equal(suggestTierFromRecruiterAi("borderline", 0), "tier_1")
  })
  it("reject with hard gaps → tier_3, without → tier_2", () => {
    assert.equal(suggestTierFromRecruiterAi("reject", 1), "tier_3")
    assert.equal(suggestTierFromRecruiterAi("reject", 0), "tier_2")
  })
  it("unknown verdict, no hard gaps → tier_2", () => {
    assert.equal(suggestTierFromRecruiterAi(null, 0), "tier_2")
  })
})

describe("suggestTierFromPrescreen", () => {
  it("returns null for non-rejection terminals", () => {
    assert.equal(suggestTierFromPrescreen({ terminal: "PASS" }), null)
    assert.equal(suggestTierFromPrescreen({ terminal: "PAUSE" }), null)
    assert.equal(suggestTierFromPrescreen({ terminal: null }), null)
  })
  it("FAIL maps by fit score", () => {
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", weightedFitScore: 0.7 }), "tier_1")
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", weightedFitScore: 0.4 }), "tier_2")
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", weightedFitScore: 0.1 }), "tier_3")
  })
  it("HARD_STOP → tier_3 unless fit is high", () => {
    assert.equal(suggestTierFromPrescreen({ terminal: "HARD_STOP", weightedFitScore: 0.2 }), "tier_3")
    assert.equal(suggestTierFromPrescreen({ terminal: "HARD_STOP", weightedFitScore: 0.7 }), "tier_2")
  })
  it("uncertain checklist softens a tier_3 to tier_2", () => {
    assert.equal(
      suggestTierFromPrescreen({ terminal: "FAIL", weightedFitScore: 0.1, checklistVerdict: "uncertain" }),
      "tier_2",
    )
  })
  it("no fit score falls back to checklist verdict", () => {
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", checklistVerdict: "uncertain" }), "tier_2")
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", checklistVerdict: "reject" }), "tier_3")
  })
})

describe("GlobalCandidateTierSchema", () => {
  it("accepts a valid record", () => {
    const out = GlobalCandidateTierSchema.safeParse({
      tier: "tier_1",
      source: "prescreen",
      reusable: true,
      updatedAt: "2026-06-16T00:00:00.000Z",
      rejectionCount: 2,
    })
    assert.equal(out.success, true)
  })
  it("rejects a bad tier", () => {
    assert.equal(
      GlobalCandidateTierSchema.safeParse({ tier: "tier_9", source: "prescreen", reusable: true, updatedAt: "x" }).success,
      false,
    )
  })
})
