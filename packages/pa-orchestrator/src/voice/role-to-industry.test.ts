import assert from "node:assert/strict"
import test from "node:test"
import { roleToIndustryBuckets, type IndustryEnumBucket } from "./role-to-industry.js"
import type { CanonicalRole } from "../onboarding.js"

test("roleToIndustryBuckets: single 'swe' → tech_software / ai_ml / fintech_finance / tech_hardware", () => {
  const out = roleToIndustryBuckets(["swe"])
  assert.deepEqual(out, [
    "tech_software",
    "ai_ml",
    "fintech_finance",
    "tech_hardware",
  ])
})

test("roleToIndustryBuckets: multi-role [swe, pm] union + dedupes (no duplicate tech_software)", () => {
  const out = roleToIndustryBuckets(["swe", "pm"])
  // swe → [tech_software, ai_ml, fintech_finance, tech_hardware]
  // pm  → [tech_software, ai_ml, fintech_finance, consumer_retail]
  // union (first-seen order) → [tech_software, ai_ml, fintech_finance, tech_hardware, consumer_retail]
  assert.deepEqual(out, [
    "tech_software",
    "ai_ml",
    "fintech_finance",
    "tech_hardware",
    "consumer_retail",
  ])
  // sanity: no duplicates
  assert.equal(new Set(out!).size, out!.length)
})

test("roleToIndustryBuckets: contains 'founder' → undefined (no filter)", () => {
  assert.equal(roleToIndustryBuckets(["founder"]), undefined)
  // Even mixed with another role, founder disables filtering.
  assert.equal(roleToIndustryBuckets(["swe", "founder"]), undefined)
})

test("roleToIndustryBuckets: contains 'other' → undefined (no filter)", () => {
  assert.equal(roleToIndustryBuckets(["other"]), undefined)
  // Mixed with concrete role: still undefined (signal too weak).
  assert.equal(roleToIndustryBuckets(["swe", "other"]), undefined)
})

test("roleToIndustryBuckets: empty array → undefined", () => {
  assert.equal(roleToIndustryBuckets([]), undefined)
})

test("roleToIndustryBuckets: undefined input → undefined", () => {
  assert.equal(roleToIndustryBuckets(undefined), undefined)
})

test("roleToIndustryBuckets: null input → undefined", () => {
  assert.equal(roleToIndustryBuckets(null), undefined)
})

test("roleToIndustryBuckets: covers each non-founder/other canonical role", () => {
  const allRoles: CanonicalRole[] = [
    "swe", "pm", "em", "designer", "research", "data", "ml",
    "ops", "marketing", "sales",
  ]
  for (const r of allRoles) {
    const out = roleToIndustryBuckets([r])
    assert.ok(
      Array.isArray(out) && out.length > 0,
      `expected non-empty buckets for role=${r}, got ${JSON.stringify(out)}`
    )
  }
})

test("roleToIndustryBuckets: 'ml' → ai_ml first, includes healthcare_biotech", () => {
  const out = roleToIndustryBuckets(["ml"])
  assert.deepEqual(out, ["ai_ml", "tech_software", "healthcare_biotech"])
})

test("roleToIndustryBuckets: 'designer' → tech_software / consumer_retail / media_entertainment", () => {
  const out = roleToIndustryBuckets(["designer"])
  assert.deepEqual(out, ["tech_software", "consumer_retail", "media_entertainment"])
})

test("roleToIndustryBuckets: returned buckets are subset of declared union type", () => {
  const VALID: ReadonlySet<IndustryEnumBucket> = new Set<IndustryEnumBucket>([
    "tech_software", "tech_hardware", "fintech_finance", "ai_ml",
    "healthcare_biotech", "consumer_retail", "media_entertainment",
    "manufacturing_industrial", "education", "other",
  ])
  const out = roleToIndustryBuckets(["swe", "pm", "em", "research", "data", "ml", "ops", "marketing", "sales", "designer"])
  assert.ok(out)
  for (const b of out!) {
    assert.ok(VALID.has(b), `unexpected bucket: ${b}`)
  }
})
