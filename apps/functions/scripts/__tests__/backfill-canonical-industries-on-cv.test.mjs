/**
 * Phase 68 (HYGIENE-03) — Tests for backfill-canonical-industries-on-cv.mjs.
 *
 * Coverage: translateLegacyToCanonicalIndustries + planCv across all canonical
 * mappings + edge cases (idempotency, unknown tokens, empty inputs).
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  LEGACY_INDUSTRY_TO_CANONICAL,
  translateLegacyToCanonicalIndustries,
  planCv,
} from "../backfill-canonical-industries-on-cv.mjs"

// ── translateLegacyToCanonicalIndustries ────────────────────────────────

test("translateLegacyToCanonicalIndustries: empty / null / undefined → []", () => {
  assert.deepEqual(translateLegacyToCanonicalIndustries([]), [])
  assert.deepEqual(translateLegacyToCanonicalIndustries(null), [])
  assert.deepEqual(translateLegacyToCanonicalIndustries(undefined), [])
})

test("translateLegacyToCanonicalIndustries: cv-ingest 10-bucket → canonical sectors", () => {
  assert.deepEqual(translateLegacyToCanonicalIndustries(["tech_software"]), [
    "software_and_saas",
  ])
  assert.deepEqual(translateLegacyToCanonicalIndustries(["fintech_finance"]), [
    "financial_technology",
  ])
  assert.deepEqual(translateLegacyToCanonicalIndustries(["healthcare_biotech"]), [
    "healthcare_and_life_sciences",
  ])
  assert.deepEqual(translateLegacyToCanonicalIndustries(["consumer_retail"]), [
    "e_commerce_and_retail",
  ])
  assert.deepEqual(translateLegacyToCanonicalIndustries(["media_entertainment"]), [
    "media_and_entertainment",
  ])
})

test("translateLegacyToCanonicalIndustries: multiple legacy → deduped canonical", () => {
  const out = translateLegacyToCanonicalIndustries([
    "tech_software",
    "ai_ml",
    "fintech_finance",
  ])
  // tech_software → software_and_saas, ai_ml → AI/ML, fintech → financial_tech
  assert.ok(out.includes("software_and_saas"))
  assert.ok(out.includes("artificial_intelligence_and_machine_learning"))
  assert.ok(out.includes("financial_technology"))
  assert.equal(out.length, 3, "no duplicates")
})

test("translateLegacyToCanonicalIndustries: 'other' / 'unknown' → [] (empty array)", () => {
  assert.deepEqual(translateLegacyToCanonicalIndustries(["other"]), [])
  assert.deepEqual(translateLegacyToCanonicalIndustries(["unknown"]), [])
  assert.deepEqual(translateLegacyToCanonicalIndustries(["other", "unknown"]), [])
})

test("translateLegacyToCanonicalIndustries: unknown token → skipped (does not throw)", () => {
  const out = translateLegacyToCanonicalIndustries(["weird_token", "tech_software"])
  // weird_token has no mapping; tech_software → software_and_saas
  assert.deepEqual(out, ["software_and_saas"])
})

test("translateLegacyToCanonicalIndustries: case-insensitive + trimmed", () => {
  assert.deepEqual(translateLegacyToCanonicalIndustries(["TECH_SOFTWARE"]), [
    "software_and_saas",
  ])
  assert.deepEqual(translateLegacyToCanonicalIndustries(["  tech_software  "]), [
    "software_and_saas",
  ])
})

test("translateLegacyToCanonicalIndustries: non-string entries skipped silently", () => {
  const out = translateLegacyToCanonicalIndustries(["tech_software", null, undefined, 42, ""])
  assert.deepEqual(out, ["software_and_saas"])
})

// ── planCv ──────────────────────────────────────────────────────────────

test("planCv: industries already non-empty → skip-already-set (idempotent)", () => {
  const r = planCv({
    industries: ["software_and_saas"],
    industryTags: ["tech_software"],
  })
  assert.equal(r.mode, "skip-already-set")
  assert.deepEqual(r.existing, ["software_and_saas"])
})

test("planCv: industries missing + industryTags missing → skip-no-mapping", () => {
  assert.equal(planCv({}).mode, "skip-no-mapping")
  assert.equal(planCv({ industryTags: [] }).mode, "skip-no-mapping")
  assert.equal(planCv({ industryTags: ["other"] }).mode, "skip-no-mapping")
})

test("planCv: industries missing + valid industryTags → rewrite", () => {
  const r = planCv({ industryTags: ["tech_software"] })
  assert.equal(r.mode, "rewrite")
  assert.deepEqual(r.from, ["tech_software"])
  assert.deepEqual(r.to, ["software_and_saas"])
})

test("planCv: industries empty array + valid industryTags → rewrite (treated as missing)", () => {
  const r = planCv({ industries: [], industryTags: ["fintech_finance"] })
  assert.equal(r.mode, "rewrite")
  assert.deepEqual(r.to, ["financial_technology"])
})

test("planCv: industries non-array + valid industryTags → rewrite", () => {
  const r = planCv({ industries: null, industryTags: ["tech_hardware"] })
  assert.equal(r.mode, "rewrite")
  assert.deepEqual(r.to, ["hardware_and_semiconductors"])
})

test("planCv: industries already set with one canonical → not overwritten", () => {
  // Even if industryTags would map to MORE canonical tokens, we don't
  // overwrite an already-populated industries field (idempotent + respects
  // any prior manual override).
  const r = planCv({
    industries: ["software_and_saas"],
    industryTags: ["tech_software", "ai_ml", "fintech_finance"],
  })
  assert.equal(r.mode, "skip-already-set")
})

// ── Sanity on the canonical map ──────────────────────────────────────────

test("LEGACY_INDUSTRY_TO_CANONICAL: covers all 10 cv-ingest bucket tokens", () => {
  for (const k of [
    "tech_software",
    "tech_hardware",
    "fintech_finance",
    "ai_ml",
    "healthcare_biotech",
    "consumer_retail",
    "media_entertainment",
    "manufacturing_industrial",
    "other",
    "unknown",
  ]) {
    assert.ok(k in LEGACY_INDUSTRY_TO_CANONICAL, `missing key: ${k}`)
  }
})
