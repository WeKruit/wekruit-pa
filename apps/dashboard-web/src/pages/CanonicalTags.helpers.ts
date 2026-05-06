/**
 * v1.6 Phase 59 — Pure helpers for the CanonicalTags page.
 *
 * Extracted so we can unit-test logic without booting a React renderer
 * (the dashboard package has no React Testing Library; tests run via
 * `node --import tsx --test`, mirroring `MatchCandidates.helpers.ts`).
 */
// Browser-safe sub-path (skips node:crypto in main barrel).
import {
  ROLE_FUNCTION_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  MAJOR_VOCAB,
  VISA_VOCAB,
  JOB_TYPE_VOCAB,
  CAREER_STAGE_VOCAB,
  LOCATION_VOCAB,
  SKILL_BUCKET_VOCAB,
} from "@wekruit/shared-tags/canonical"

export type Axis =
  | "roleFunction"
  | "industrySector"
  | "major"
  | "visa"
  | "jobType"
  | "careerStage"
  | "location"
  | "relevantTags"
  | "skillBucket"

export interface AxisInfo {
  key: Axis
  values: readonly string[]
  matchSemantics: "hard_filter" | "soft_score"
  isOpenVocab: boolean
  /** D16 — runtime add-able via overlay. */
  supportsOverlay: boolean
}

export const AXES: AxisInfo[] = [
  {
    key: "roleFunction",
    values: ROLE_FUNCTION_VOCAB,
    matchSemantics: "hard_filter",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "industrySector",
    values: INDUSTRY_SECTOR_VOCAB,
    matchSemantics: "soft_score",
    isOpenVocab: false,
    supportsOverlay: true,
  },
  {
    key: "major",
    values: MAJOR_VOCAB,
    matchSemantics: "soft_score",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "visa",
    values: VISA_VOCAB,
    matchSemantics: "hard_filter",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "jobType",
    values: JOB_TYPE_VOCAB,
    matchSemantics: "hard_filter",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "careerStage",
    values: CAREER_STAGE_VOCAB,
    matchSemantics: "hard_filter",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "location",
    values: LOCATION_VOCAB,
    matchSemantics: "hard_filter",
    isOpenVocab: false,
    supportsOverlay: false,
  },
  {
    key: "relevantTags",
    values: [], // open vocab — pattern-based, no enum
    matchSemantics: "soft_score",
    isOpenVocab: true,
    supportsOverlay: false,
  },
  {
    key: "skillBucket",
    values: SKILL_BUCKET_VOCAB,
    matchSemantics: "soft_score",
    isOpenVocab: false,
    supportsOverlay: false,
  },
]

/**
 * Sort sandbox tokens by evidence count desc — most-proposed first so admin
 * triage focuses on highest-signal tokens.
 */
export function sortSandboxTokens<T extends { count?: number }>(rows: T[]): T[] {
  const out = rows.slice()
  out.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
  return out
}

/** Format a percentage 0..1 → "12.3%". Returns "—" for non-finite. */
export function pct(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(1)}%`
}

/** Format an ISO timestamp → "YYYY-MM-DD HH:MM:SS" (UTC). */
export function fmtTime(iso: string | undefined | null): string {
  if (!iso) return "—"
  return iso.slice(0, 19).replace("T", " ")
}
