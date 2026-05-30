/**
 * onboarding-canonical-tags.ts — LLM-driven canonical-enum VALIDATION for the
 * shared-onboarding answer path (2026-05-30).
 *
 * Adam directive (2026-05-30): "no regex allowed AT ALL in the tagging system."
 *
 * The AGENT (the @openai/agents Claire / the conversation extractor) maps a
 * candidate's free-form onboarding answer to canonical enum values. This module
 * is the deterministic GATE between that LLM proposal and the sole tag writer
 * (`applyPartialUserTags`, D8):
 *
 *   - it accepts the LLM's STRUCTURED picks (closed enums + free numbers),
 *   - validates EVERY pick against the `@wekruit/shared-tags` zod enums,
 *   - drops anything off-vocab (never invents or pattern-matches a tag),
 *   - returns a clean `PartialUserTags` the writer can persist.
 *
 * There is ZERO regex / string-pattern classification here. The only string
 * ops are trivial mechanical normalization (trim / lowercase / dedupe) — never
 * a `/\b(startup|seed)\b/ → "early_startup"` style classifier. Multi-value
 * arrays are OR (e.g. companySize ["early_startup","enterprise"] = "open to a
 * small startup OR big tech").
 */

import {
  ROLE_FUNCTION_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  JOB_TYPE_VOCAB,
  CAREER_STAGE_VOCAB,
  VISA_VOCAB,
  COMPANY_SIZE_VOCAB,
  HARDNESS_AXIS_VOCAB,
  type RoleFunction,
  type IndustrySector,
  type JobType,
  type CareerStage,
  type Visa,
  type CompanySize,
  type HardnessAxis,
  type PreferenceHardnessEntry,
} from "@wekruit/shared-tags"
import type { PartialUserTags } from "./user-tags-writer.js"

/**
 * The structured canonical extraction the LLM proposes for a single onboarding
 * answer. Every field is OPTIONAL — the agent fills ONLY what the answer
 * supports and leaves the rest unset. Array fields are OR (multi-pick); the
 * agent captures EVERY value the candidate mentioned.
 *
 * Values are accepted as loose strings/arrays here and validated against the
 * shared-tags closed enums by {@link validateOnboardingCanonicalTags}; off-vocab
 * values are dropped, never coerced or pattern-matched.
 */
export interface OnboardingCanonicalTagInput {
  /** WHAT the candidate wants to do — ROLE_FUNCTION_VOCAB (OR). */
  targetRoleFunction?: string[] | string | null
  /** Role functions the candidate wants to AVOID — ROLE_FUNCTION_VOCAB (OR). */
  negativeRoleFunction?: string[] | string | null
  /** WHAT KIND of company — INDUSTRY_SECTOR_VOCAB (OR). */
  industrySector?: string[] | string | null
  /** Industries to AVOID — INDUSTRY_SECTOR_VOCAB (OR). */
  negativeIndustrySector?: string[] | string | null
  /** Company-size preference — COMPANY_SIZE_VOCAB (OR). */
  companySize?: string[] | string | null
  /** Where the candidate wants to work — free-form normalized location tokens (OR). */
  targetLocations?: string[] | string | null
  /** Country/region targets, e.g. ["usa"], ["anywhere"] (OR). */
  targetCountry?: string[] | string | null
  /** Job type — JOB_TYPE_VOCAB (OR). */
  targetJobType?: string[] | string | null
  /** Seniority — CAREER_STAGE_VOCAB (single). */
  careerStage?: string | null
  /** Work-authorization — VISA_VOCAB (single). */
  visaStatus?: string | null
  /** Minimum acceptable base salary in USD. */
  minSalary?: number | null
  /**
   * Per-axis hardness / negotiability (the buffer layer). Keyed by
   * `HARDNESS_AXIS_VOCAB` (salary, industrySector, companyStage, companySize,
   * location, jobType, careerStage, roleFunction). Each entry is
   * `{ hardness: "hard"|"soft", bufferPct?, bufferSteps? }` — the LLM captures
   * BOTH whether the axis is a dealbreaker AND the DEGREE of flexibility when
   * the candidate signals one ("could flex to 130 from 140" → soft +
   * bufferPct). Validated against HARDNESS_AXIS_VOCAB; provenance is stamped by
   * the caller. Emit ONLY axes the candidate clearly signalled.
   */
  preferenceHardness?: Record<string, unknown> | null
}

/** Caller-supplied provenance stamped onto each captured hardness entry. */
export interface HardnessProvenance {
  source: "onboarding" | "conversation" | "website" | "admin" | "default_inferred"
  confidence?: number
  updatedAt?: string
}

const ROLE_FUNCTION_SET = new Set<string>(ROLE_FUNCTION_VOCAB)
const INDUSTRY_SECTOR_SET = new Set<string>(INDUSTRY_SECTOR_VOCAB)
const JOB_TYPE_SET = new Set<string>(JOB_TYPE_VOCAB)
const CAREER_STAGE_SET = new Set<string>(CAREER_STAGE_VOCAB)
const VISA_SET = new Set<string>(VISA_VOCAB)
const COMPANY_SIZE_SET = new Set<string>(COMPANY_SIZE_VOCAB)
const HARDNESS_AXIS_SET = new Set<string>(HARDNESS_AXIS_VOCAB)

/** Trivial mechanical normalize (NOT classification): trim + lowercase. */
function norm(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

/** Coerce a scalar/array LLM value to a string[] (mechanical only). */
function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(norm).filter((v): v is string => v !== null)
  const single = norm(value)
  return single ? [single] : []
}

/**
 * Keep only members of `vocab`; dedupe; preserve order. Off-vocab values are
 * DROPPED (never coerced). Returns undefined when nothing valid remains.
 */
function validateEnumList<T extends string>(value: unknown, vocab: Set<string>): T[] | undefined {
  const out: T[] = []
  const seen = new Set<string>()
  for (const candidate of toList(value)) {
    if (vocab.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate)
      out.push(candidate as T)
    }
  }
  return out.length > 0 ? out : undefined
}

function validateEnumScalar<T extends string>(value: unknown, vocab: Set<string>): T | undefined {
  const candidate = norm(value)
  return candidate && vocab.has(candidate) ? (candidate as T) : undefined
}

/** Free-form location tokens — kept as canonical-ish lowercase strings (OR). */
function validateLocationList(value: unknown): string[] | undefined {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of toList(value)) {
    const token = raw.replace(/\s+/g, "_")
    if (!seen.has(token)) {
      seen.add(token)
      out.push(token)
    }
  }
  return out.length > 0 ? out : undefined
}

function validateSalary(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

function clamp(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.max(min, Math.min(max, value))
}

/**
 * Validate the LLM's per-axis hardness/negotiability picks (the buffer layer)
 * against `HARDNESS_AXIS_VOCAB`. Each entry must carry `hardness: hard|soft`;
 * the optional `bufferPct` (continuous axes — salary) and `bufferSteps`
 * (ordinal axes — companyStage/companySize/careerStage) capture the DEGREE of
 * flexibility the candidate signalled. Off-vocab axes and entries without a
 * valid hardness are dropped. Provenance is stamped from `provenance`.
 */
function validatePreferenceHardness(
  value: unknown,
  provenance: HardnessProvenance,
): Record<string, PreferenceHardnessEntry> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, PreferenceHardnessEntry> = {}
  for (const [axis, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const key = axis.trim()
    if (!HARDNESS_AXIS_SET.has(key)) continue
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue
    const entry = rawEntry as Record<string, unknown>
    const hardnessRaw = typeof entry.hardness === "string" ? entry.hardness.trim().toLowerCase() : ""
    if (hardnessRaw !== "hard" && hardnessRaw !== "soft") continue
    const built: PreferenceHardnessEntry = {
      hardness: hardnessRaw,
      source: provenance.source,
      ...(provenance.confidence !== undefined ? { confidence: provenance.confidence } : {}),
      ...(provenance.updatedAt ? { updatedAt: provenance.updatedAt } : {}),
    }
    // Degree-of-flexibility buffers — only when the candidate signalled one.
    const bufferPct = clamp(entry.bufferPct, 0, 1)
    if (bufferPct !== undefined) built.bufferPct = bufferPct
    const bufferStepsRaw = clamp(entry.bufferSteps, 0, 4)
    if (bufferStepsRaw !== undefined) built.bufferSteps = Math.round(bufferStepsRaw)
    out[key as HardnessAxis] = built
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Validate the LLM's canonical picks against the shared-tags vocab and project
 * them into a writer-ready `PartialUserTags`. Drops every off-vocab value.
 *
 * companySize is OR end-to-end: a multi-pick array is preserved; a single pick
 * collapses to a scalar (the user-tags schema accepts `enum | enum[]`).
 */
export function validateOnboardingCanonicalTags(
  input: OnboardingCanonicalTagInput | null | undefined,
  hardnessProvenance: HardnessProvenance = { source: "onboarding" },
): PartialUserTags {
  const tags: PartialUserTags = {}
  if (!input || typeof input !== "object") return tags

  const targetRoleFunction = validateEnumList<RoleFunction>(input.targetRoleFunction, ROLE_FUNCTION_SET)
  if (targetRoleFunction) tags.targetRoleFunction = targetRoleFunction

  const negativeRoleFunction = validateEnumList<RoleFunction>(input.negativeRoleFunction, ROLE_FUNCTION_SET)
  if (negativeRoleFunction) tags.negativeRoleFunction = negativeRoleFunction

  const industrySector = validateEnumList<IndustrySector>(input.industrySector, INDUSTRY_SECTOR_SET)
  if (industrySector) tags.industrySector = industrySector

  const negativeIndustrySector = validateEnumList<IndustrySector>(
    input.negativeIndustrySector,
    INDUSTRY_SECTOR_SET,
  )
  if (negativeIndustrySector) tags.negativeIndustrySector = negativeIndustrySector

  const companySizeList = validateEnumList<CompanySize>(input.companySize, COMPANY_SIZE_SET)
  if (companySizeList) {
    // OR: keep the array for multi-pick; collapse a single pick to a scalar.
    tags.companySize = companySizeList.length === 1 ? companySizeList[0] : companySizeList
  }

  const targetJobType = validateEnumList<JobType>(input.targetJobType, JOB_TYPE_SET)
  if (targetJobType) tags.targetJobType = targetJobType

  const careerStage = validateEnumScalar<CareerStage>(input.careerStage, CAREER_STAGE_SET)
  if (careerStage) tags.careerStage = careerStage

  const visaStatus = validateEnumScalar<Visa>(input.visaStatus, VISA_SET)
  // visaStatus on PartialUserTags is the legacy 6-token enum; the canonical
  // 4-token VISA_VOCAB is a strict subset, so a typed extension keeps the
  // contract aligned with the matcher (same pattern as the conversation
  // extractor's visaStatus write).
  if (visaStatus) {
    ;(tags as Omit<PartialUserTags, "visaStatus"> & { visaStatus?: Visa }).visaStatus = visaStatus
  }

  const targetLocations = validateLocationList(input.targetLocations)
  if (targetLocations) tags.targetLocations = targetLocations

  const targetCountry = validateLocationList(input.targetCountry)
  if (targetCountry) tags.targetCountry = targetCountry

  const minSalary = validateSalary(input.minSalary)
  if (minSalary !== undefined) tags.minSalary = minSalary

  // Per-axis hardness / negotiability (the buffer layer). Stamped with
  // provenance; written via the writer's per-axis preferenceHardness merge.
  const preferenceHardness = validatePreferenceHardness(input.preferenceHardness, hardnessProvenance)
  if (preferenceHardness) {
    ;(tags as { preferenceHardness?: Record<string, PreferenceHardnessEntry> }).preferenceHardness =
      preferenceHardness
  }

  return tags
}
