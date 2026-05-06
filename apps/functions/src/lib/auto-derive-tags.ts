/**
 * Phase 71 — Auto-derive helper for `targetRoleFunction` + `careerStage`.
 * [QADATA-01]
 *
 * Phase 61's `paQaEvaluatorWeekly` filters pa-users by
 * `tags.targetRoleFunction.length > 0`. Today only ~5 users have completed
 * onboarding fully, so the QA sampleSize is below the 50-user statistical
 * floor. Adam directive (REQ QADATA-01..04): auto-derive sensible defaults
 * for users who already have CV signals but never finished the chat-side
 * onboarding probe — that should jump the eligible pool from 5 → 100s
 * without requiring the user to re-engage.
 *
 * Strategy (D1, D5, D15):
 *   1. Skill-bucket vote — count `skills[].bucket` occurrences. If
 *      `programming_languages | frameworks_and_libraries | devops_and_tooling
 *      | cloud_and_infrastructure | databases` >= 3 → `software_engineering`.
 *      `data_and_ml` >= 2 → `data_analysis`. `design_and_ux` >= 2 →
 *      `creatives_and_design`.
 *   2. Title regex secondary pass — when bucket vote is empty, fall back to
 *      `workHistory[0].title`. SE / data analyst / PM / designer regex.
 *   3. Confidence — sum-of-bucket-hits / 8 (capped to 1). 0 when no roles
 *      derived.
 *   4. Source label — `auto-derive-skill-bucket` when ≥3 hits in the SE/DA/
 *      design buckets, `auto-derive-title-regex` when only the title regex
 *      fired, `fallback` when neither produced anything.
 *
 * `careerStage` derivation:
 *   - yoe range or string parsed; thresholds 12+/8+/5+/2+/1+/>0 →
 *     principal/staff/senior/mid_level/junior/entry_level. null when YoE
 *     unknown / 0 — the caller leaves the axis blank rather than guessing.
 *
 * Pure functions, no Firestore I/O. Caller is responsible for read + write
 * (the Phase 71 `fill-tag-gaps.mjs` script funnels through `mergeUserTags` /
 * `applyPartialUserTags` — USER-TAG-05 sole-writer invariant).
 */

import type { Skill, RoleFunction } from "@wekruit/shared-tags"

/**
 * Bucket sets that vote toward each role-function. Derived empirically from
 * CV-skill distributions across the existing 529 pa-users — SE candidates
 * dominate `programming_languages` + `frameworks_and_libraries`, data folks
 * lead `data_and_ml`, designers lead `design_and_ux`.
 */
const SE_INDICATORS = [
  "programming_languages",
  "frameworks_and_libraries",
  "devops_and_tooling",
  "cloud_and_infrastructure",
  "databases",
] as const
const DA_INDICATORS = ["data_and_ml"] as const
const DESIGN_INDICATORS = ["design_and_ux"] as const

/**
 * Optional `SkillEntry`-like shape — the pa-users.tags.skills array may be
 * post-Phase 52 SkillSchema objects OR legacy raw strings (pre-migration).
 * Strings contribute zero signal here (no bucket); the caller is encouraged
 * to upgrade via `applyPartialUserTags` or the migrate-skills-to-objects
 * script before passing in.
 */
export type DeriveSkill = Pick<Skill, "name" | "bucket"> | { name: string }

export interface DeriveInput {
  skills?: ReadonlyArray<DeriveSkill | string>
  industrySector?: ReadonlyArray<string>
  workHistory?: ReadonlyArray<{ title?: string | null }>
  yoeRange?: [number, number] | string | number | null | undefined
}

export type AutoDeriveSource =
  | "auto-derive-skill-bucket"
  | "auto-derive-title-regex"
  | "fallback"

export interface DeriveOutput {
  /** ROLE_FUNCTION_VOCAB tokens (multi-pick allowed). Empty when no signal. */
  targetRoleFunction: RoleFunction[]
  /** [0, 1] — sum-of-bucket-hits / 8 capped to 1. 0 when fallback. */
  confidence: number
  source: AutoDeriveSource
  /** Human-readable trace. seScore=N daScore=N designScore=N. */
  reasoning: string
}

/**
 * Auto-derive `targetRoleFunction[]` from the candidate's CV signals.
 *
 * Returns `{ targetRoleFunction: [], confidence: 0, source: "fallback" }`
 * when no signal — caller decides whether to write nothing or stamp a
 * placeholder.
 */
export function autoDeriveTargetRoleFunction(input: DeriveInput): DeriveOutput {
  // 1. Skill-bucket vote.
  const buckets = (input.skills ?? []).reduce<Record<string, number>>(
    (acc, raw) => {
      const bucket =
        typeof raw === "string"
          ? null
          : (raw as { bucket?: string }).bucket ?? null
      if (bucket && typeof bucket === "string") {
        acc[bucket] = (acc[bucket] ?? 0) + 1
      }
      return acc
    },
    {}
  )

  const seScore = SE_INDICATORS.reduce((s, b) => s + (buckets[b] ?? 0), 0)
  const daScore = DA_INDICATORS.reduce((s, b) => s + (buckets[b] ?? 0), 0)
  const designScore = DESIGN_INDICATORS.reduce(
    (s, b) => s + (buckets[b] ?? 0),
    0
  )

  const roles: RoleFunction[] = []
  if (seScore >= 3) roles.push("software_engineering")
  if (daScore >= 2) roles.push("data_analysis")
  if (designScore >= 2) roles.push("creatives_and_design")

  let source: AutoDeriveSource =
    roles.length > 0 ? "auto-derive-skill-bucket" : "fallback"

  // 2. Title regex secondary — when bucket vote yielded nothing.
  if (roles.length === 0 && input.workHistory && input.workHistory.length > 0) {
    const recentTitle = String(input.workHistory[0]?.title ?? "")
      .toLowerCase()
      .trim()
    if (recentTitle) {
      // Order matters — check more-specific patterns first.
      if (
        /(data scientist|data analyst|analytics|business intelligence|bi engineer|ml engineer|machine learning)/i.test(
          recentTitle
        )
      ) {
        roles.push("data_analysis")
      } else if (
        /(product manager|\bpm\b|product owner|technical product manager|tpm)/i.test(
          recentTitle
        )
      ) {
        roles.push("product_management")
      } else if (
        /(designer|ux designer|ui designer|product designer|visual designer|graphic designer)/i.test(
          recentTitle
        )
      ) {
        roles.push("creatives_and_design")
      } else if (
        /(software engineer|software developer|backend|frontend|fullstack|full-stack|developer|swe|sde|programmer|software architect)/i.test(
          recentTitle
        )
      ) {
        roles.push("software_engineering")
      }
      if (roles.length > 0) source = "auto-derive-title-regex"
    }
  }

  // 3. Confidence — bucket hits sum / 8 capped at 1. 0 when fallback.
  const totalBucketHits = seScore + daScore + designScore
  const confidence =
    roles.length === 0 ? 0 : Math.min(1, totalBucketHits / 8)

  return {
    targetRoleFunction: roles,
    confidence,
    source,
    reasoning: `seScore=${seScore} daScore=${daScore} designScore=${designScore}`,
  }
}

/**
 * Auto-derive `careerStage` from a yoe range or string.
 *
 * Thresholds (cumulative; checked top-down so 12+ wins over 8+ etc.):
 *   - 12+ → principal
 *   - 8+ → staff
 *   - 5+ → senior
 *   - 2+ → mid_level
 *   - 1+ → junior
 *   - >0 → entry_level
 *   - 0 / unknown → null (caller leaves the axis blank)
 *
 * Tuple input uses the MAX of the range (more generous toward the user).
 * String input parses the first integer (e.g. "3-5 years" → 3, "10+" → 10).
 */
export function autoDeriveCareerStage(
  yoeRange?: [number, number] | string | number | null | undefined
): string | null {
  let years = 0
  if (Array.isArray(yoeRange) && yoeRange.length === 2) {
    const max = yoeRange[1]
    const min = yoeRange[0]
    if (typeof max === "number" && Number.isFinite(max)) years = max
    else if (typeof min === "number" && Number.isFinite(min)) years = min
  } else if (typeof yoeRange === "string") {
    const m = yoeRange.match(/(\d+)/)
    if (m) {
      const parsed = parseInt(m[1], 10)
      if (!Number.isNaN(parsed)) years = parsed
    }
  } else if (typeof yoeRange === "number" && Number.isFinite(yoeRange)) {
    years = yoeRange
  }
  if (years >= 12) return "principal"
  if (years >= 8) return "staff"
  if (years >= 5) return "senior"
  if (years >= 2) return "mid_level"
  if (years >= 1) return "junior"
  if (years > 0) return "entry_level"
  return null
}
