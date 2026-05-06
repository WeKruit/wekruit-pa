/**
 * Phase 52 — Canonical `industrySector` vocab. [TAG-02]
 *
 * Closed enum, 42 spelled-out values, no abbreviations (D5).
 * Add-able by admin via Firestore overlay sandbox→promote (D16, TAG-11).
 * Soft score axis on match (D9, MATCH-05).
 *
 * Ports `INDUSTRY_VOCAB` 38 from `wekruit-scraping/src/wekruit_matching/
 * enrichment/classifier.py` and extends to 42 by adding (D2 mandate):
 *  - `crypto_web3_blockchain`
 *  - `gaming_and_esports`
 *  - `artificial_intelligence_and_machine_learning`
 *  - `accessibility_and_assistive_technology`
 *
 * Use `resolveCanonicalVocab('industry-sector', INDUSTRY_SECTOR_VOCAB, db)`
 * (see `overlay.ts`) to merge static vocab with admin-promoted runtime tokens.
 */

import { z } from "zod"

export const INDUSTRY_SECTOR_VOCAB = [
  "artificial_intelligence_and_machine_learning",
  "financial_technology",
  "healthcare_and_life_sciences",
  "biotechnology_and_pharmaceuticals",
  "software_and_saas",
  "hardware_and_semiconductors",
  "e_commerce_and_retail",
  "consumer_goods",
  "cybersecurity",
  "crypto_web3_blockchain",
  "gaming_and_esports",
  "education_technology",
  "real_estate_and_proptech",
  "transportation_and_logistics",
  "automotive_and_mobility",
  "aerospace_and_defense",
  "energy_and_utilities",
  "clean_energy_and_climate_tech",
  "manufacturing_and_industrial",
  "construction_and_built_environment",
  "agriculture_and_foodtech",
  "hospitality_and_travel",
  "media_and_entertainment",
  "advertising_and_marketing",
  "telecommunications",
  "professional_services",
  "legal_services",
  "accounting_and_audit",
  "management_consulting",
  "human_resources_and_recruiting",
  "non_profit_and_social_impact",
  "public_sector_and_government",
  "research_and_academia",
  "sports_and_recreation",
  "fashion_and_apparel",
  "beauty_and_personal_care",
  "arts_and_culture",
  "accessibility_and_assistive_technology",
  "robotics_and_automation",
  "quantum_computing",
  "space_technology",
  "technology_general",
] as const

export type IndustrySector = (typeof INDUSTRY_SECTOR_VOCAB)[number]

export const IndustrySectorSchema = z.enum(INDUSTRY_SECTOR_VOCAB)

/** Multi-pick array helper (used for both candidate `industrySector[]`
 *  and job-side `industrySector[]`). */
export const IndustrySectorListSchema = z.array(IndustrySectorSchema)
