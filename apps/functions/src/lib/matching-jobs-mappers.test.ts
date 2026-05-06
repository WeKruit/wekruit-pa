/**
 * v1.6 Phase 55 (MATCH-02) — matching-jobs mapper tests.
 *
 * Coverage:
 *  - All 18 jobright categories (17 mapped + general empty) → RoleFunction[]
 *  - All 38+ legacy industry keys → IndustrySector[]
 *  - Title regex extracts role from common titles (15+ test cases)
 *  - Multi-role detection (e.g. "Senior SWE / Tech Lead")
 *  - Empty/null inputs return `[]`
 *  - Unknown category falls through to title regex
 *  - Idempotent: running mapper twice on same input gives same output
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION,
  LEGACY_INDUSTRY_TO_CANONICAL,
  inferRoleFromTitle,
  mapJobrightCategoryToRoleFunction,
  mapLegacyIndustryToCanonical,
  computeMatchingJobV16Fields,
} from "./matching-jobs-mappers.js"

import { ROLE_FUNCTION_VOCAB, INDUSTRY_SECTOR_VOCAB } from "@wekruit/shared-tags"

// ─── Vocab integrity ──────────────────────────────────────────────────────────

describe("matching-jobs-mappers: vocab integrity", () => {
  it("every JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION value is valid RoleFunction", () => {
    for (const [cat, roles] of Object.entries(JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION)) {
      for (const r of roles) {
        assert.ok(
          ROLE_FUNCTION_VOCAB.includes(r as never),
          `${cat} → ${r} is not in ROLE_FUNCTION_VOCAB`
        )
      }
    }
  })

  it("every LEGACY_INDUSTRY_TO_CANONICAL value is valid IndustrySector", () => {
    for (const [key, sectors] of Object.entries(LEGACY_INDUSTRY_TO_CANONICAL)) {
      for (const s of sectors) {
        assert.ok(
          INDUSTRY_SECTOR_VOCAB.includes(s as never),
          `${key} → ${s} is not in INDUSTRY_SECTOR_VOCAB`
        )
      }
    }
  })

  it("category map covers 17 mapped + general (18 entries)", () => {
    assert.equal(Object.keys(JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION).length, 18)
  })

  it("industry map covers 38+ legacy keys", () => {
    assert.ok(
      Object.keys(LEGACY_INDUSTRY_TO_CANONICAL).length >= 38,
      `expected >=38 legacy industry keys, got ${Object.keys(LEGACY_INDUSTRY_TO_CANONICAL).length}`
    )
  })
})

// ─── mapJobrightCategoryToRoleFunction direct hits ────────────────────────────

describe("mapJobrightCategoryToRoleFunction: direct category hits", () => {
  it("tech → software_engineering", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("tech"), ["software_engineering"])
  })
  it("data_analytics → data_analysis", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("data_analytics"), ["data_analysis"])
  })
  it("engineering → engineering_and_development", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("engineering"), [
      "engineering_and_development",
    ])
  })
  it("product → product_management", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("product"), ["product_management"])
  })
  it("business → business_analyst", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("business"), ["business_analyst"])
  })
  it("design → creatives_and_design", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("design"), ["creatives_and_design"])
  })
  it("consulting → consultant", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("consulting"), ["consultant"])
  })
  it("accounting_finance → accounting_and_finance", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("accounting_finance"), [
      "accounting_and_finance",
    ])
  })
  it("marketing → marketing", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("marketing"), ["marketing"])
  })
  it("management → management_and_executive", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("management"), [
      "management_and_executive",
    ])
  })
  it("sales → sales", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("sales"), ["sales"])
  })
  it("human_resources → human_resources", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("human_resources"), [
      "human_resources",
    ])
  })
  it("legal → legal_and_compliance", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("legal"), ["legal_and_compliance"])
  })
  it("arts_entertainment → arts_and_entertainment", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("arts_entertainment"), [
      "arts_and_entertainment",
    ])
  })
  it("education → education_and_training", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("education"), [
      "education_and_training",
    ])
  })
  it("government → public_sector_and_government", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("government"), [
      "public_sector_and_government",
    ])
  })
  it("customer_service → customer_service_and_support", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("customer_service"), [
      "customer_service_and_support",
    ])
  })

  it("uppercase + whitespace tolerated", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction(" Tech "), ["software_engineering"])
    assert.deepEqual(mapJobrightCategoryToRoleFunction("DESIGN"), ["creatives_and_design"])
  })
})

// ─── general / unknown → title regex fallback ────────────────────────────────

describe("mapJobrightCategoryToRoleFunction: general/unknown fallback", () => {
  it("general + SWE title → software_engineering via regex", () => {
    assert.deepEqual(
      mapJobrightCategoryToRoleFunction("general", "Senior Software Engineer"),
      ["software_engineering"]
    )
  })

  it("general + no title → []", () => {
    assert.deepEqual(mapJobrightCategoryToRoleFunction("general"), [])
  })

  it("unknown category + PM title → includes product_management", () => {
    // "Senior Product Manager" also matches "Manager" → management_and_executive
    // (multi-role detection is intentional). Assert inclusion not equality.
    const out = mapJobrightCategoryToRoleFunction("zzz_unknown", "Senior Product Manager")
    assert.ok(out.includes("product_management"), `expected product_management in ${out}`)
  })

  it("missing category + DS title → data_analysis", () => {
    assert.deepEqual(
      mapJobrightCategoryToRoleFunction(undefined, "Data Scientist"),
      ["data_analysis"]
    )
  })

  it("multi-role title: SWE / Tech Lead → both functions", () => {
    const out = mapJobrightCategoryToRoleFunction(
      "general",
      "Senior Software Engineer / Tech Lead"
    )
    assert.ok(out.includes("software_engineering"), `expected software_engineering in ${out}`)
    assert.ok(
      out.includes("management_and_executive"),
      `expected management_and_executive in ${out}`
    )
  })

  it("ML title spans SWE + data_analysis", () => {
    const out = mapJobrightCategoryToRoleFunction("general", "Machine Learning Engineer")
    assert.ok(out.includes("software_engineering"))
    assert.ok(out.includes("data_analysis"))
  })
})

// ─── inferRoleFromTitle direct ───────────────────────────────────────────────

describe("inferRoleFromTitle: regex matches", () => {
  const cases: Array<[string, string]> = [
    ["Software Engineer", "software_engineering"],
    ["Backend Developer", "software_engineering"],
    ["iOS Developer", "software_engineering"],
    ["Data Analyst", "data_analysis"],
    ["Business Intelligence Analyst", "data_analysis"],
    ["Product Manager", "product_management"],
    ["Business Analyst", "business_analyst"],
    ["UX Designer", "creatives_and_design"],
    ["Senior Consultant", "consultant"],
    ["Staff Accountant", "accounting_and_finance"],
    ["Marketing Manager", "marketing"],
    ["Sales Director", "sales"],
    ["Human Resources Manager", "human_resources"],
    ["Compliance Counsel", "legal_and_compliance"],
    ["Performing Artist", "arts_and_entertainment"],
    ["Math Teacher", "education_and_training"],
    ["Federal Policy Analyst", "public_sector_and_government"],
    ["Customer Success Manager", "customer_service_and_support"],
  ]

  for (const [title, expected] of cases) {
    it(`"${title}" includes ${expected}`, () => {
      const out = inferRoleFromTitle(title)
      assert.ok(out.includes(expected as never), `${title} → ${out}, expected ${expected}`)
    })
  }

  it("Tech Lead by itself → management_and_executive", () => {
    const out = inferRoleFromTitle("Tech Lead")
    assert.ok(out.includes("management_and_executive"))
  })

  it("nonsense title → []", () => {
    assert.deepEqual(inferRoleFromTitle("xyzzy plugh"), [])
  })

  it("empty title → []", () => {
    assert.deepEqual(inferRoleFromTitle(""), [])
    assert.deepEqual(inferRoleFromTitle(undefined), [])
    assert.deepEqual(inferRoleFromTitle(null), [])
  })
})

// ─── mapLegacyIndustryToCanonical ────────────────────────────────────────────

describe("mapLegacyIndustryToCanonical: direct hits", () => {
  const cases: Array<[string, string]> = [
    ["tech", "technology_general"],
    ["fintech", "financial_technology"],
    ["healthtech", "healthcare_and_life_sciences"],
    ["healthcare", "healthcare_and_life_sciences"],
    ["ecommerce", "e_commerce_and_retail"],
    ["enterprise_saas", "software_and_saas"],
    ["ai_ml", "artificial_intelligence_and_machine_learning"],
    ["cybersecurity", "cybersecurity"],
    ["gaming", "gaming_and_esports"],
    ["social_media", "media_and_entertainment"],
    ["hardware", "hardware_and_semiconductors"],
    ["consulting", "management_consulting"],
    ["telecom", "telecommunications"],
    ["automotive", "automotive_and_mobility"],
    ["aerospace_defense", "aerospace_and_defense"],
    ["construction", "construction_and_built_environment"],
    ["defense", "aerospace_and_defense"],
    ["security", "cybersecurity"],
    ["manufacturing", "manufacturing_and_industrial"],
    ["retail", "e_commerce_and_retail"],
    ["media", "media_and_entertainment"],
    ["education", "education_technology"],
    ["government", "public_sector_and_government"],
    ["energy", "energy_and_utilities"],
    ["transportation", "transportation_and_logistics"],
    ["hospitality", "hospitality_and_travel"],
    ["real_estate", "real_estate_and_proptech"],
    ["nonprofit", "non_profit_and_social_impact"],
    ["legal", "legal_services"],
    ["pharma", "biotechnology_and_pharmaceuticals"],
    ["banking", "financial_technology"],
    ["finance", "financial_technology"],
    ["insurance", "financial_technology"],
    ["logistics", "transportation_and_logistics"],
    ["food_service", "hospitality_and_travel"],
    ["agriculture", "agriculture_and_foodtech"],
    ["mining", "manufacturing_and_industrial"],
    ["utilities", "energy_and_utilities"],
  ]

  for (const [key, expected] of cases) {
    it(`${key} → [${expected}]`, () => {
      assert.deepEqual(mapLegacyIndustryToCanonical(key), [expected])
    })
  }

  it("other → []", () => {
    assert.deepEqual(mapLegacyIndustryToCanonical("other"), [])
  })

  it("unknown → []", () => {
    assert.deepEqual(mapLegacyIndustryToCanonical("unknown"), [])
  })

  it("empty / null / undefined → []", () => {
    assert.deepEqual(mapLegacyIndustryToCanonical(""), [])
    assert.deepEqual(mapLegacyIndustryToCanonical(null), [])
    assert.deepEqual(mapLegacyIndustryToCanonical(undefined), [])
  })

  it("uppercase + whitespace tolerated", () => {
    assert.deepEqual(mapLegacyIndustryToCanonical(" FINTECH "), ["financial_technology"])
  })

  it("unmapped key → [] (no fallback)", () => {
    assert.deepEqual(mapLegacyIndustryToCanonical("zzz_not_a_real_key"), [])
  })
})

// ─── computeMatchingJobV16Fields (live-data shape) ──────────────────────────

describe("computeMatchingJobV16Fields: live-data shape (production)", () => {
  it("typical jobright doc: industryKey='engineering' + roleTitle='Optical Manufacturing Technician'", () => {
    const out = computeMatchingJobV16Fields({
      industry: "engineering",
      industryKey: "engineering",
      roleTitle: "Optical Manufacturing Technician 2",
    })
    // industryKey 'engineering' is a category → engineering_and_development
    assert.deepEqual(out.newRoleFunction, ["engineering_and_development"])
    assert.equal(out.mapperUsed.role, "industryKey_as_category")
    // 'engineering' is NOT an industry token → industrySector falls through
    assert.deepEqual(out.newIndustrySector, [])
  })

  it("industryKey is industry-style: 'fintech' → industrySector", () => {
    const out = computeMatchingJobV16Fields({
      industryKey: "fintech",
      roleTitle: "Software Engineer",
    })
    // No category match for 'fintech' → fall to title regex
    assert.deepEqual(out.newRoleFunction, ["software_engineering"])
    assert.equal(out.mapperUsed.role, "title_regex_fallback")
    // 'fintech' is in industry map → financial_technology
    assert.deepEqual(out.newIndustrySector, ["financial_technology"])
    assert.equal(out.mapperUsed.industry, "industryKey")
  })

  it("industryEnum array: ['healthcare_biotech'] → healthcare_and_life_sciences", () => {
    const out = computeMatchingJobV16Fields({
      industryKey: "healthtech",
      industryEnum: ["healthcare_biotech"],
      roleTitle: "Software Engineering Intern",
    })
    assert.deepEqual(out.newIndustrySector, ["healthcare_and_life_sciences"])
    assert.equal(out.mapperUsed.industry, "industryEnum_array")
    assert.deepEqual(out.newRoleFunction, ["software_engineering"])
  })

  it("industryKey 'human_resources' → category match", () => {
    const out = computeMatchingJobV16Fields({
      industryKey: "human_resources",
      roleTitle: "Organizational Development Intern",
    })
    assert.deepEqual(out.newRoleFunction, ["human_resources"])
    assert.equal(out.mapperUsed.role, "industryKey_as_category")
  })

  it("industryKey 'sales' → sales category", () => {
    const out = computeMatchingJobV16Fields({
      industryKey: "sales",
      roleTitle: "Platinum Relationship Manager",
    })
    assert.deepEqual(out.newRoleFunction, ["sales"])
  })

  it("industryKey 'tech' resolves via category map (tech → software_engineering)", () => {
    const out = computeMatchingJobV16Fields({
      industryKey: "tech",
      roleTitle: "Software Engineer",
    })
    // 'tech' is in BOTH category map (→ software_engineering) and
    // industry map (→ technology_general). Resolution order says category
    // map wins for roleFunction; industry map populates industrySector.
    assert.deepEqual(out.newRoleFunction, ["software_engineering"])
    assert.equal(out.mapperUsed.role, "industryKey_as_category")
    assert.deepEqual(out.newIndustrySector, ["technology_general"])
    assert.equal(out.mapperUsed.industry, "industryKey")
  })

  it("falls through to no_mapping if nothing matches", () => {
    const out = computeMatchingJobV16Fields({
      industryKey: "zzz_garbage",
      roleTitle: "xyzzy plugh",
    })
    assert.deepEqual(out.newRoleFunction, [])
    assert.deepEqual(out.newIndustrySector, [])
    assert.equal(out.mapperUsed.role, "no_mapping")
    assert.equal(out.mapperUsed.industry, "no_mapping")
  })

  it("uses jobTitle when roleTitle missing", () => {
    const out = computeMatchingJobV16Fields({
      jobTitle: "Senior Data Analyst",
    })
    assert.deepEqual(out.newRoleFunction, ["data_analysis"])
  })

  it("explicit category beats industryKey", () => {
    const out = computeMatchingJobV16Fields({
      category: "tech",
      industryKey: "fintech",
      roleTitle: "Senior Engineer",
    })
    // category 'tech' → software_engineering (direct), not via industryKey
    assert.deepEqual(out.newRoleFunction, ["software_engineering"])
    assert.equal(out.mapperUsed.role, "category_direct")
    // industrySector still from industryKey
    assert.deepEqual(out.newIndustrySector, ["financial_technology"])
  })
})

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("idempotency: deterministic for same input", () => {
  it("same category twice → same output", () => {
    const a = mapJobrightCategoryToRoleFunction("tech")
    const b = mapJobrightCategoryToRoleFunction("tech")
    assert.deepEqual(a, b)
  })

  it("same general+title twice → same output", () => {
    const a = mapJobrightCategoryToRoleFunction("general", "Senior Software Engineer / Tech Lead")
    const b = mapJobrightCategoryToRoleFunction("general", "Senior Software Engineer / Tech Lead")
    assert.deepEqual(a, b)
  })

  it("same legacy industry key twice → same output", () => {
    const a = mapLegacyIndustryToCanonical("fintech")
    const b = mapLegacyIndustryToCanonical("fintech")
    assert.deepEqual(a, b)
  })
})
