/**
 * Phase 52 — Canonical `roleFunction` vocab. [TAG-01]
 *
 * Source: jobright `utm_campaign` 17 verbatim values (D1).
 * Closed enum, multi-pick. Hard filter axis on match (D9, MATCH-03).
 *
 * Adam-locked decisions (CLAUDE.md v1.6 design lock):
 *  - D1: 17 jobright `utm_campaign` values verbatim
 *  - D5: NO abbreviations — use `software_engineering` not `swe`
 *
 * Multi-pick allowed on user side (`tags.targetRoleFunction: RoleFunction[]`)
 * and job side (`matching-jobs.roleFunction: RoleFunction[]`).
 */

import { z } from "zod"

export const ROLE_FUNCTION_VOCAB = [
  "software_engineering",
  "engineering_and_development",
  "data_analysis",
  "product_management",
  "business_analyst",
  "creatives_and_design",
  "consultant",
  "accounting_and_finance",
  "marketing",
  "management_and_executive",
  "sales",
  "human_resources",
  "legal_and_compliance",
  "arts_and_entertainment",
  "education_and_training",
  "public_sector_and_government",
  "customer_service_and_support",
] as const

export type RoleFunction = (typeof ROLE_FUNCTION_VOCAB)[number]

export const RoleFunctionSchema = z.enum(ROLE_FUNCTION_VOCAB)

/** Multi-pick array helper. */
export const RoleFunctionListSchema = z.array(RoleFunctionSchema)
