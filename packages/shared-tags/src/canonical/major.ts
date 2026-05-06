/**
 * Phase 52 — Canonical `major` vocab. [TAG-03]
 *
 * Closed enum, 60+ spelled-out values, no abbreviations (D5).
 * **Soft-score signal, NOT hard filter** (D3) — SWE candidates have varied majors.
 *
 * Adam-locked decisions:
 *  - D3: major is a soft-score signal (not gate)
 *  - D5: spelled-out, no abbreviations
 */

import { z } from "zod"

export const MAJOR_VOCAB = [
  // Engineering
  "computer_science",
  "software_engineering",
  "electrical_engineering",
  "mechanical_engineering",
  "chemical_engineering",
  "civil_engineering",
  "biomedical_engineering",
  "industrial_engineering",
  "materials_science_engineering",
  "aerospace_engineering",
  "environmental_engineering",
  // Math + physical sciences
  "mathematics",
  "statistics",
  "applied_mathematics",
  "physics",
  "chemistry",
  "biology",
  "biochemistry",
  "neuroscience",
  "cognitive_science",
  // Information / data
  "data_science",
  "information_systems",
  "information_technology",
  "cybersecurity",
  // Business
  "business_administration",
  "finance",
  "accounting",
  "economics",
  "marketing",
  "supply_chain_management",
  "entrepreneurship",
  "management",
  "international_business",
  // Communication
  "communications",
  "journalism",
  "media_studies",
  // Social science
  "psychology",
  "sociology",
  "anthropology",
  "political_science",
  "international_relations",
  "public_policy",
  "public_health",
  // Humanities
  "philosophy",
  "history",
  "english_literature",
  "linguistics",
  "education",
  // Design / arts
  "design",
  "graphic_design",
  "industrial_design",
  "architecture",
  "fine_arts",
  "music",
  "film_and_media_production",
  // Applied / professional
  "law",
  "premed",
  "nursing",
  "pharmacy",
  "kinesiology",
  // Earth + environment
  "agriculture",
  "environmental_science",
  "geology",
  "geography",
  "urban_planning",
  // Other
  "hospitality_management",
  "other_humanities",
  "other_social_sciences",
  "other_stem",
] as const

export type Major = (typeof MAJOR_VOCAB)[number]

export const MajorSchema = z.enum(MAJOR_VOCAB)

export const MajorListSchema = z.array(MajorSchema)
