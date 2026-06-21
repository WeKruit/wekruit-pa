import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  bestTier,
  reconcileGlobalTier,
  isReusableTier,
  tierRank,
  suggestTierFromRecruiterAi,
  recruiterQualityScore,
  RECRUITER_TIER_1_SCORE_CUTOFF,
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

describe("suggestTierFromRecruiterAi (HYBRID: percentile size + absolute floor)", () => {
  // A "top" candidate: clean advance + all signals maxed → score 1.0 ≥ p95 cutoff.
  const top = { confidence: 1, strongBackground: true, hardRatio: 1, fitRatio: 1, bonusRatio: 1, antiRatio: 0 }

  it("tier_1 ONLY for a top-percentile CLEAN advance (score ≥ p95 cutoff)", () => {
    assert.ok(recruiterQualityScore("advance", top) >= RECRUITER_TIER_1_SCORE_CUTOFF)
    assert.equal(suggestTierFromRecruiterAi("advance", 0, top), "tier_1")
  })

  it("a top-scoring BORDERLINE is never tier_1 (absolute floor — must be a clean advance)", () => {
    // borderline can't clear the floor regardless of how the pool ranks it
    assert.equal(suggestTierFromRecruiterAi("borderline", 0, top), "tier_2")
  })

  it("an advance WITH a hard gap is not a clean advance → not tier_1", () => {
    assert.equal(suggestTierFromRecruiterAi("advance", 1, top), "tier_2")
  })

  it("a mid-scoring advance is tier_2, not tier_1 (below the percentile cutoff)", () => {
    assert.equal(suggestTierFromRecruiterAi("advance", 0, { confidence: 0.5, hardRatio: 0.5 }), "tier_2")
    assert.equal(suggestTierFromRecruiterAi("advance", 0), "tier_2", "no signals → score 0.4 → tier_2")
  })

  it("a clean advance is NEVER curved into tier_3 (anti-stack-ranking floor)", () => {
    // even with everything else zero, a clean advance scores ≥0.4 > p20 cutoff
    assert.equal(suggestTierFromRecruiterAi("advance", 0), "tier_2")
  })

  it("a weak reject (bottom percentile, not a clean advance) → tier_3", () => {
    assert.equal(suggestTierFromRecruiterAi("reject", 2, { confidence: 0.2 }), "tier_3")
  })

  it("a reject with strong signals clears the p20 floor → tier_2 (reusable)", () => {
    assert.equal(suggestTierFromRecruiterAi("reject", 1, { hardRatio: 1, confidence: 0.8, strongBackground: true }), "tier_2")
  })

  it("unknown/unscored verdict → score 0 (bottom) and not a clean advance → tier_3", () => {
    // In practice callers return null before this for a missing verdict; defensive.
    assert.equal(suggestTierFromRecruiterAi(null, 0), "tier_3")
  })
})

describe("suggestTierFromPrescreen (top-5% tier_1, strong-bg tier_2)", () => {
  it("returns null for non-rejection terminals", () => {
    assert.equal(suggestTierFromPrescreen({ terminal: "PASS" }), null)
    assert.equal(suggestTierFromPrescreen({ terminal: "PAUSE" }), null)
    assert.equal(suggestTierFromPrescreen({ terminal: null }), null)
  })
  it("tier_1 ONLY for a near-pass FAIL (fit ≥ 0.90)", () => {
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", weightedFitScore: 0.95 }), "tier_1")
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", weightedFitScore: 0.9 }), "tier_1")
    // below the cutoff is NOT tier_1 anymore (this was the over-tiering bug)
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", weightedFitScore: 0.85 }), "tier_3")
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", weightedFitScore: 0.5 }), "tier_3")
  })
  it("HARD_STOP can never be tier_1, even at high fit", () => {
    assert.equal(suggestTierFromPrescreen({ terminal: "HARD_STOP", weightedFitScore: 0.99 }), "tier_3")
    assert.equal(suggestTierFromPrescreen({ terminal: "HARD_STOP", weightedFitScore: 0.99, strongBackground: true }), "tier_2")
  })
  it("non-top-5% → tier_2 only with a strong school/company, else tier_3", () => {
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", weightedFitScore: 0.5, strongBackground: true }), "tier_2")
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", weightedFitScore: 0.5, strongBackground: false }), "tier_3")
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL", strongBackground: true }), "tier_2")
    assert.equal(suggestTierFromPrescreen({ terminal: "FAIL" }), "tier_3")
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
