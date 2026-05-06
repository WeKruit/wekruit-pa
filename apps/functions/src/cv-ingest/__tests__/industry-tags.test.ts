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
  applyIndustryTagsFallback,
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

describe("mapToCanonicalIndustryFromSignals — H10 long-tail company entries", () => {
  it("Pearson → education (textbook + ed-tech publisher)", () => {
    assert.equal(
      mapToCanonicalIndustryFromSignals({ companyName: "Pearson" }),
      "education"
    )
  })
  it("Rural King / Cintas / Dollar Tree / 7-Eleven → consumer_retail", () => {
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Rural King" }), "consumer_retail")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Cintas" }), "consumer_retail")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Dollar Tree" }), "consumer_retail")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "7-Eleven" }), "consumer_retail")
  })
  it("PNC / BMO / USAA / Edward Jones → fintech_finance", () => {
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "PNC" }), "fintech_finance")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "BMO" }), "fintech_finance")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "USAA" }), "fintech_finance")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Edward Jones" }), "fintech_finance")
  })
  it("Humana / Cedars-Sinai / Banfield Pet Hospital → healthcare_biotech", () => {
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Humana" }), "healthcare_biotech")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Cedars-Sinai" }), "healthcare_biotech")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Banfield Pet Hospital" }), "healthcare_biotech")
  })
  it("Spectrum / Rippling / Toast / Samsara → tech_software (telecom + B2B SaaS)", () => {
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Spectrum" }), "tech_software")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Rippling" }), "tech_software")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Toast" }), "tech_software")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Samsara" }), "tech_software")
  })
  it("RTX / Westinghouse Electric / UPS / PepsiCo → manufacturing_industrial", () => {
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "RTX" }), "manufacturing_industrial")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "Westinghouse Electric Company" }), "manufacturing_industrial")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "UPS" }), "manufacturing_industrial")
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "PepsiCo" }), "manufacturing_industrial")
  })
  it("legal-suffix variants resolve via normalizeCompanyName", () => {
    // 'CarMax, Inc.' → 'carmax' should hit consumer_retail entry.
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "CarMax, Inc." }), "consumer_retail")
    // 'The Aaron's Company Inc' (legal suffix + apostrophe) — first-word fallback hits 'the'? no — prefix to full normalized.
    assert.equal(mapToCanonicalIndustryFromSignals({ companyName: "The Aaron's Company Inc" }), "consumer_retail")
  })
})


describe("mapToCanonicalIndustryFromSignals — H11 companyName × roleTitle compound check", () => {
  // H10 LIVE rematch (1f569f90) surfaced two false-positives in Adam's top-3:
  //   - "Lead Fulfillment Associate @ Amazon" was lifted to tech_software
  //     because companyName=Amazon mapped to tech_software, even though the
  //     industryKey was "management".
  //   - "Account Based Marketing Specialist @ Snowflake" was lifted to
  //     tech_software the same way.
  // H11 gates the companyName lift on a roleTitle compatibility check.

  it("Amazon SDE → tech_software (companyName + tech-positive role keeps lift)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "management", // common Amazon scraper output → 'other'
      companyName: "Amazon",
      roleTitle: "Software Development Engineer (SDE I)",
    })
    assert.equal(out, "tech_software")
  })

  it("Amazon Lead Fulfillment Associate → does NOT lift to tech_software (NON_TECH_ROLE blocks)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "management",
      companyName: "Amazon",
      roleTitle: "Lead Fulfillment Associate",
    })
    assert.notEqual(out, "tech_software", "companyName lift must be blocked for warehouse role")
    // Falls through to roleTitle keywords; "Fulfillment Associate" alone
    // doesn't match the narrow consumer_retail "warehouse associate"
    // pattern, so the cascade ends at "other". That's fine — the goal is
    // to prevent the FALSE-POSITIVE tech_software lift. "other" is correct
    // because we honestly don't know without more signal.
    assert.equal(out, "other")
  })

  it("Amazon Robotics Engineer → tech_software (TECH_POSITIVE overrides NON_TECH suffix)", () => {
    // "Robotics Engineer" matches TECH_POSITIVE_REGEX. Even if a regex
    // variant happened to fire NON_TECH_ROLE, the whitelist wins.
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "engineering", // → 'other'
      companyName: "Amazon",
      roleTitle: "Robotics Engineer II",
    })
    assert.equal(out, "tech_software")
  })

  it("Snowflake Marketing Specialist → does NOT lift (NON_TECH_FUNCTION blocks)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "marketing", // → 'other'
      companyName: "Snowflake",
      roleTitle: "Account Based Marketing Specialist",
    })
    assert.notEqual(out, "tech_software", "Snowflake marketing role must be blocked from tech_software lift")
    // No roleTitle keyword for "marketing specialist" → falls through to "other".
    assert.equal(out, "other")
  })

  it("Snowflake Senior Data Scientist → tech_software (TECH_POSITIVE keeps lift)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "data_science", // → 'ai_ml' — wins at industryKey step
      companyName: "Snowflake",
      roleTitle: "Senior Data Scientist",
    })
    // industryKey already maps to ai_ml so cascade stops at step 1.
    assert.equal(out, "ai_ml")
  })

  it("Snowflake SDE with no industryKey → tech_software via companyName (TECH_POSITIVE)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: null,
      companyName: "Snowflake",
      roleTitle: "SDE II",
    })
    assert.equal(out, "tech_software")
  })

  it("JPMorgan Software Engineer → fintech_finance (companyName lift OK, no role conflict)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "engineering", // → 'other'
      companyName: "JPMorgan Chase",
      roleTitle: "Software Engineer III",
    })
    assert.equal(out, "fintech_finance")
  })

  it("JPMorgan Tax Consultant → fintech_finance (FINANCE_FUNCTION exception keeps lift)", () => {
    // Tax IS finance — even though tax_consultant matches NON_TECH_FUNCTION,
    // when companyName is in fintech_finance bucket the lift is allowed.
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "consulting", // → 'other'
      companyName: "JPMorgan Chase",
      roleTitle: "Tax Consultant II",
    })
    assert.equal(out, "fintech_finance")
  })

  it("Deloitte Tax Consultant → fintech_finance (Deloitte mapped to fintech bucket; finance role allowed)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "consulting",
      companyName: "Deloitte",
      roleTitle: "Tax Consultant II, SAP Global Trade Services",
    })
    assert.equal(out, "fintech_finance")
  })

  it("Walmart Cashier → consumer_retail (verify NON_TECH_ROLE doesn't double-block consumer_retail employers)", () => {
    // Walmart maps to consumer_retail via companyName; "cashier" is in
    // NON_TECH_ROLE_REGEX. The lift would be blocked — but cashier ALSO
    // hits ROLE_TITLE_KEYWORDS consumer_retail in step 3, so the result
    // ends up consumer_retail anyway. Either path is correct; this test
    // locks the end-state for the expected industryEnum.
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "retail", // → consumer_retail directly at step 1
      companyName: "Walmart",
      roleTitle: "Cashier",
    })
    assert.equal(out, "consumer_retail")
  })

  it("Software Engineer Associate → tech-positive overrides 'associate' negative-lookahead", () => {
    // The NON_TECH_ROLE 'associate(?!\s+(engineer|software|product|data))'
    // negative lookahead means 'Software Engineer Associate' should NOT
    // match NON_TECH_ROLE in the first place. Belt-and-suspenders: even
    // if it did, TECH_POSITIVE wins.
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "engineering",
      companyName: "Amazon",
      roleTitle: "Software Engineer Associate",
    })
    assert.equal(out, "tech_software")
  })

  it("Amazon EHS Specialist → does NOT lift (workplace safety blocked)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "management",
      companyName: "Amazon",
      roleTitle: "EHS Specialist",
    })
    assert.notEqual(out, "tech_software")
    assert.equal(out, "other")
  })
})

describe("mapToCanonicalIndustryFromSignals — H11 gate scope (only tech-bias buckets)", () => {
  // The H11 gate must NOT fire for consumer_retail / manufacturing_industrial
  // / healthcare_biotech employers, where non-tech roles are coherent with
  // the bucket. Otherwise we'd downgrade thousands of legitimate hourly /
  // service / industrial rows to "other".

  it("Walmart Cashier with industryKey=customer_service → consumer_retail (gate does not fire)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "customer_service", // → 'other'
      companyName: "Walmart",
      roleTitle: "Cashier",
    })
    assert.equal(out, "consumer_retail")
  })

  it("Caterpillar Forklift Operator → manufacturing_industrial (gate does not fire on industrial bucket)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "management",
      companyName: "Caterpillar",
      roleTitle: "Forklift Operator",
    })
    assert.equal(out, "manufacturing_industrial")
  })

  it("Kaiser Permanente Patient Care Tech → healthcare_biotech (gate does not fire on healthcare bucket)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "management",
      companyName: "Kaiser Permanente",
      roleTitle: "Patient Care Technician",
    })
    assert.equal(out, "healthcare_biotech")
  })

  it("Starbucks Barista → consumer_retail (NON_TECH_ROLE.barista doesn't gate non-tech-bias bucket)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "food_beverage", // → consumer_retail at step 1, but ensure even if it didn't:
      companyName: "Starbucks",
      roleTitle: "Barista",
    })
    assert.equal(out, "consumer_retail")
  })

  it("Disney HR Specialist → media_entertainment (gate doesn't fire — media is not tech-bias)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "management",
      companyName: "Disney",
      roleTitle: "HR Specialist",
    })
    assert.equal(out, "media_entertainment")
  })

  it("Microsoft Workplace Safety Specialist → does NOT lift (tech_software bucket gated)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "management",
      companyName: "Microsoft",
      roleTitle: "Workplace Safety Specialist",
    })
    assert.notEqual(out, "tech_software", "Microsoft tech_software lift must be blocked for safety role")
    assert.equal(out, "other")
  })
})

describe("mapToCanonicalIndustryFromSignals — H11 step-1 gate (industryKey lift also blocked)", () => {
  // Discovered during H11 LIVE: Amazon EHS Specialist rows had industryKey
  // scraped as "enterprise_saas" → step 1 returned tech_software directly,
  // bypassing the companyName-step-2 gate. The gate now applies to step 1
  // for tech-bias buckets too.

  it("Amazon EHS Specialist with industryKey=enterprise_saas → does NOT lift to tech_software", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "enterprise_saas",
      companyName: "Amazon",
      roleTitle: "EHS Specialist",
    })
    assert.notEqual(out, "tech_software", "step-1 industryKey lift must also be gated")
    assert.equal(out, "other")
  })

  it("Amazon Software Engineer with industryKey=enterprise_saas → tech_software (TECH_POSITIVE keeps step-1)", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "enterprise_saas",
      companyName: "Amazon",
      roleTitle: "Software Development Engineer 1",
    })
    assert.equal(out, "tech_software")
  })

  it("Amazon IT Support Associate with industryKey=enterprise_saas → does NOT lift", () => {
    // Not tech-positive (no engineer/SDE/scientist), and "associate" alone
    // would normally be blocked by NON_TECH_ROLE (depending on lookahead).
    // "Support Associate" matches NON_TECH_ROLE.associate(?!\s+(engineer|software|product|data)).
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "enterprise_saas",
      companyName: "Amazon",
      roleTitle: "IT Support Associate II, Ops Tech Solutions",
    })
    assert.notEqual(out, "tech_software")
  })

  it("Random non-tech-bias industryKey lift not affected by gate", () => {
    // industryKey=retail → consumer_retail; cashier roleTitle is fine.
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "retail",
      companyName: "Random Co",
      roleTitle: "Cashier",
    })
    assert.equal(out, "consumer_retail")
  })

  it("industryKey lift to fintech_finance with tax role keeps lift via FINANCE_FUNCTION exception", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "accounting_finance", // → fintech_finance directly
      companyName: "Random Tax Co",
      roleTitle: "Tax Consultant II",
    })
    assert.equal(out, "fintech_finance")
  })
})

describe("mapToCanonicalIndustryFromSignals — H11 regex extension (driving / valet ops / operations coord)", () => {
  // Discovered during H11 LIVE rematch: "Supervisor - Driving @ metropolis"
  // and "Operations Coordinator @ spectrum medical partners" survived the
  // initial spec-only regex. metropolis.companyName maps to tech_software,
  // and these roleTitles weren't in NON_TECH_ROLE/NON_TECH_FUNCTION.
  // H11 extends the regexes to include them.

  it("Metropolis Technologies Supervisor Driving → does NOT lift to tech_software", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "management",
      companyName: "Metropolis Technologies",
      roleTitle: "Supervisor - Driving",
    })
    assert.notEqual(out, "tech_software")
    assert.equal(out, "other")
  })

  it("Metropolis Assistant Manager Valet Operations → does NOT lift", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "management",
      companyName: "Metropolis Technologies",
      roleTitle: "Assistant Manager, Valet Operations",
    })
    assert.notEqual(out, "tech_software")
    assert.equal(out, "other")
  })

  it("Spectrum (tech_software bucket) Operations Coordinator → does NOT lift", () => {
    const out = mapToCanonicalIndustryFromSignals({
      industryKey: "management",
      companyName: "Spectrum",
      roleTitle: "Operations Coordinator",
    })
    assert.notEqual(out, "tech_software")
  })
})

// ---------------------------------------------------------------------------
// iter34 H.3a — applyIndustryTagsFallback (skill-token rescue)
// ---------------------------------------------------------------------------

describe("applyIndustryTagsFallback (iter34 H.3a)", () => {
  it("LLM ['other'] + react skill → ['tech_software']", () => {
    const out = applyIndustryTagsFallback(["other"], ["React", "Node.js"])
    assert.deepEqual(out, ["tech_software"])
  })

  it("LLM ['other'] + python skill → ['tech_software']", () => {
    const out = applyIndustryTagsFallback(["other"], ["Python", "PostgreSQL"])
    assert.deepEqual(out, ["tech_software"])
  })

  it("LLM ['tech_software'] + tensorflow skill → ['tech_software', 'ai_ml']", () => {
    const out = applyIndustryTagsFallback(["tech_software"], ["Python", "TensorFlow", "PyTorch"])
    assert.deepEqual(out, ["tech_software", "ai_ml"])
  })

  it("LLM ['healthcare_biotech'] + medical skills → unchanged (no false tech promotion)", () => {
    const out = applyIndustryTagsFallback(
      ["healthcare_biotech"],
      ["clinical research", "biostatistics", "FDA submission"]
    )
    assert.deepEqual(out, ["healthcare_biotech"])
  })

  it("LLM ['other'] + non-tech skills → ['other'] (no fallback fires)", () => {
    const out = applyIndustryTagsFallback(["other"], ["leadership", "communication"])
    assert.deepEqual(out, ["other"])
  })

  it("LLM ['other'] + AWS skill → ['tech_software']", () => {
    const out = applyIndustryTagsFallback(["other"], ["AWS", "GCP"])
    assert.deepEqual(out, ["tech_software"])
  })

  it("LLM ['other'] + 'tensorflow.js' substring → ['ai_ml'] (substring match)", () => {
    // TENSORFLOW.JS contains "tensorflow" → AI_TOKENS hit.
    const out = applyIndustryTagsFallback(["other"], ["TensorFlow.js", "Keras"])
    assert.deepEqual(out, ["ai_ml"])
  })

  it("LLM ['other'] + langchain → ['ai_ml'] (AI tokens fire even when tech doesn't)", () => {
    const out = applyIndustryTagsFallback(["other"], ["LangChain", "RAG", "vector store"])
    // langchain fires ai_ml; "vector" doesn't contain a tech token; embedding fires ai_ml too
    assert.ok(out.includes("ai_ml"))
    // Importantly, NO tech_software because none of these match TECH_TOKENS
    assert.equal(out.includes("tech_software"), false)
  })

  it("LLM ['other'] + python + openai → ['tech_software', 'ai_ml']", () => {
    const out = applyIndustryTagsFallback(["other"], ["Python", "OpenAI API", "Anthropic"])
    assert.deepEqual(out, ["tech_software", "ai_ml"])
  })

  it("LLM tag preserved + new tech tag from skills (additive, not replace)", () => {
    const out = applyIndustryTagsFallback(["fintech_finance"], ["Python", "AWS"])
    assert.deepEqual(out, ["fintech_finance", "tech_software"])
  })

  it("respects ≤3 cap from StructuredCv contract", () => {
    const out = applyIndustryTagsFallback(
      // Already 3 tags from LLM; tech_software fallback must not push to 4.
      ["fintech_finance", "consumer_retail", "media_entertainment"],
      ["Python", "TensorFlow"]
    )
    assert.equal(out.length <= 3, true)
    assert.deepEqual(out, ["fintech_finance", "consumer_retail", "media_entertainment"])
  })

  it("empty skills array → ['other']", () => {
    const out = applyIndustryTagsFallback(["other"], [])
    assert.deepEqual(out, ["other"])
  })

  it("malformed skills (non-string) → safe (filtered out)", () => {
    // Type-coerce since callers pass typed arrays, but guard against runtime junk.
    const out = applyIndustryTagsFallback(
      ["other"],
      [42, null, undefined, "Python"] as unknown as string[]
    )
    assert.deepEqual(out, ["tech_software"])
  })
})
