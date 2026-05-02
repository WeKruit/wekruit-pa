/**
 * Stream H8 — multi-signal cascade mapper tests.
 *
 * Covers the F2-redo `mapToCanonicalIndustryFromSignals(signals)` cascade:
 *   industryKey → companyName → roleTitle → "other"
 *
 * Legacy `mapToCanonicalIndustry(raw)` is exercised separately by F1
 * cv-ingest tests; here we just guard the identity short-circuit + the
 * three new INDUSTRY_KEY_MAP additions (technology, consumer_electronics,
 * ai_infrastructure, aerospace_defense).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  mapToCanonicalIndustry,
  mapToCanonicalIndustryFromSignals,
  normalizeCompanyName,
} from "../industry-tags.js"

describe("mapToCanonicalIndustry — H8 INDUSTRY_KEY_MAP additions", () => {
  it("'technology' → tech_software (was 'other' before H8)", () => {
    assert.equal(mapToCanonicalIndustry("technology"), "tech_software")
  })
  it("'consumer_electronics' → tech_hardware", () => {
    assert.equal(mapToCanonicalIndustry("consumer_electronics"), "tech_hardware")
  })
  it("'ai_infrastructure' → ai_ml", () => {
    assert.equal(mapToCanonicalIndustry("ai_infrastructure"), "ai_ml")
  })
  it("'aerospace_defense' → manufacturing_industrial", () => {
    assert.equal(mapToCanonicalIndustry("aerospace_defense"), "manufacturing_industrial")
  })
  it("legacy identity short-circuit still works", () => {
    assert.equal(mapToCanonicalIndustry("fintech_finance"), "fintech_finance")
    assert.equal(mapToCanonicalIndustry("ai_ml"), "ai_ml")
  })
  it("unknown free-text still falls through to other", () => {
    assert.equal(mapToCanonicalIndustry("space_exploration"), "other")
  })
})

describe("normalizeCompanyName", () => {
  it("strips legal suffixes case-insensitively", () => {
    assert.equal(normalizeCompanyName("Stripe, Inc."), "stripe")
    assert.equal(normalizeCompanyName("Microsoft Corporation"), "microsoft")
    assert.equal(normalizeCompanyName("Bridgewater Associates LLC"), "bridgewater_associates")
  })
  it("collapses punctuation + whitespace into single underscores", () => {
    assert.equal(normalizeCompanyName("J.P. Morgan Chase & Co."), "j_p_morgan_chase")
    assert.equal(normalizeCompanyName("  Bank of America  "), "bank_of_america")
  })
  it("returns empty string for null/empty", () => {
    assert.equal(normalizeCompanyName(null), "")
    assert.equal(normalizeCompanyName(""), "")
  })
})

describe("mapToCanonicalIndustryFromSignals — cascade ordering", () => {
  it("industryKey wins when set + mappable", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "fintech",
      companyName: "Acme Software", // would be "other" in companyMap
      roleTitle: "Data Scientist", // would be ai_ml via role
    })
    assert.equal(out, "fintech_finance")
  })

  it("falls through to companyName when industryKey is 'engineering' (job-function)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "engineering",
      companyName: "Stripe",
      roleTitle: "Senior SWE",
    })
    assert.equal(out, "fintech_finance", "Stripe should win over generic role")
  })

  it("falls through to roleTitle when industryKey + companyName both miss", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "marketing",
      companyName: "Some Random Startup LLC",
      roleTitle: "Senior Machine Learning Engineer",
    })
    assert.equal(out, "ai_ml")
  })

  it("returns 'other' when all three signals miss", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "marketing",
      companyName: "Random Co",
      roleTitle: "Marketing Manager",
    })
    assert.equal(out, "other")
  })

  it("handles missing fields without throwing", () => {
    assert.equal(mapToCanonicalIndustryFromSignals({}), "other")
    assert.equal(
      mapToCanonicalIndustryFromSignals({ companyName: "Anthropic" }),
      "ai_ml"
    )
    assert.equal(
      mapToCanonicalIndustryFromSignals({ roleTitle: "Site Reliability Engineer" }),
      "tech_software"
    )
  })

  it("hardware roleTitle wins over generic 'engineer'", () => {
    // "embedded firmware engineer" must match hardware regex BEFORE the
    // tech_software broad pattern (regex order matters in cascade).
    assert.equal(
      mapToCanonicalIndustryFromSignals({
        industryKey: "engineering",
        companyName: "Random Co",
        roleTitle: "Embedded Firmware Engineer",
      }),
      "tech_hardware"
    )
  })

  it("companyName matches by first-word fallback (e.g. 'Stripe Payments')", () => {
    const out = mapToCanonicalIndustryFromSignals({
      companyName: "Stripe Payments Inc.",
      roleTitle: "Marketing Lead",
    })
    assert.equal(out, "fintech_finance")
  })

  it("known company defies mismatched industryKey via cascade — but cascade is industryKey-first when industryKey IS mappable", () => {
    // Apple's industryKey may be scraped as "tech" (software), but the
    // companyName-bypass only fires when industryKey returns "other".
    // This test locks the priority: industryKey wins when not "other".
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "tech", // → tech_software
      companyName: "Apple",
      roleTitle: "iOS Engineer",
    })
    assert.equal(out, "tech_software", "industryKey wins when mappable, even if companyName disagrees")
  })

  it("Anthropic/OpenAI overrides generic role-title 'software engineer'", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "consulting", // -> other
      companyName: "Anthropic",
      roleTitle: "Senior Software Engineer",
    })
    assert.equal(out, "ai_ml")
  })
})
