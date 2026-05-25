/**
 * Phase EX1 PR-A — pure aggregation from per-entry extractions to a
 * per-user {@link DerivedExperienceModel}.
 *
 * No I/O. Same input → same output. Property-tested in `__tests__/derive.test.ts`.
 *
 * Aggregation rules (plan §3):
 *   * yearsTotal       = sum(durationMonths) / 12
 *   * yearsPerSkill    = sum(durationMonths for entries containing skill) / 12
 *   * skillRecency     = max(endDate or "present") across entries that
 *                        emitted the skill
 *   * titleTrajectory  = titles sorted by startDate asc (stable for ties)
 *   * seniorityCurrent = inferred from the latest entry's title
 *   * responsibilityCurrent = the latest entry's responsibilityLevel
 *   * industryHistory  = sum(years) per industryGuess bucket
 *   * unverifiedSkills = candidateSkills − union(extractedSkills)
 */

import type {
  DerivedExperienceModel,
  WorkEntryExtractionOutput,
} from "./types.js"
import { inferSeniorityFromTitle } from "./seniority.js"

/**
 * Per-entry source plus the metadata derive needs but the LLM output
 * doesn't carry. We deliberately do not stash this on the output
 * itself to keep the cache schema lean.
 */
export interface DeriveEntryInput {
  output: WorkEntryExtractionOutput
  /** ISO yyyy-mm-dd. Used to sort titleTrajectory and pick "current". */
  startDate: string | null
  /**
   * ISO yyyy-mm-dd or null. Drives skillRecency: null → "present".
   * Must reflect the original work-history input, not the LLM output.
   */
  endDate: string | null
  title: string
}

export interface DeriveExperienceArgs {
  entries: DeriveEntryInput[]
  claimedSkills: string[]
  /**
   * Override "now" for deterministic tests. Production should leave
   * unset; we default to `new Date().toISOString()` at call time.
   */
  now?: string
}

const PRESENT = "present"

function monthsToYears(months: number): number {
  return Math.round((months / 12) * 100) / 100
}

function sortByStartDateAsc(a: DeriveEntryInput, b: DeriveEntryInput): number {
  // null startDate sorts LAST so "undated" entries don't pollute the
  // earliest slot. Two nulls preserve insertion order (stable sort).
  if (a.startDate === b.startDate) return 0
  if (a.startDate === null) return 1
  if (b.startDate === null) return -1
  return a.startDate < b.startDate ? -1 : 1
}

function isLater(a: string, b: string): boolean {
  if (a === PRESENT) return b !== PRESENT
  if (b === PRESENT) return false
  return a > b
}

/**
 * Pure aggregator. See module docstring for rules.
 */
export function deriveExperienceModel(
  args: DeriveExperienceArgs
): DerivedExperienceModel {
  const yearsPerSkill: Record<string, number> = {}
  const skillRecency: Record<string, string> = {}
  const industryHistory: Record<string, number> = {}
  let totalMonths = 0

  for (const entry of args.entries) {
    totalMonths += entry.output.durationMonths
    const entryYears = entry.output.durationMonths / 12
    const recency = entry.endDate ?? PRESENT

    for (const raw of entry.output.extractedSkills) {
      const skill = raw.toLowerCase().trim()
      if (!skill) continue
      yearsPerSkill[skill] = (yearsPerSkill[skill] ?? 0) + entryYears
      const prev = skillRecency[skill]
      if (!prev || isLater(recency, prev)) {
        skillRecency[skill] = recency
      }
    }

    const industry = entry.output.industryGuess?.toLowerCase().trim() || null
    if (industry) {
      industryHistory[industry] = (industryHistory[industry] ?? 0) + entryYears
    }
  }

  // Round all year values to 2dp at the end so per-skill rounding
  // doesn't compound during summation.
  for (const k of Object.keys(yearsPerSkill)) {
    yearsPerSkill[k] = monthsToYears(yearsPerSkill[k]! * 12)
  }
  for (const k of Object.keys(industryHistory)) {
    industryHistory[k] = monthsToYears(industryHistory[k]! * 12)
  }

  const sorted = [...args.entries].sort(sortByStartDateAsc)
  const titleTrajectory = sorted.map((e) => e.title)
  const latest = sorted[sorted.length - 1]
  const seniorityCurrent = latest
    ? inferSeniorityFromTitle(latest.title)
    : "unknown"
  const responsibilityCurrent: DerivedExperienceModel["responsibilityCurrent"] =
    latest ? latest.output.responsibilityLevel : "unknown"

  const extractedSet = new Set<string>()
  for (const entry of args.entries) {
    for (const skill of entry.output.extractedSkills) {
      extractedSet.add(skill.toLowerCase().trim())
    }
  }
  const unverifiedSkills = args.claimedSkills
    .map((s) => s.toLowerCase().trim())
    .filter((s) => s && !extractedSet.has(s))
    // Deduplicate while preserving order.
    .filter((s, i, arr) => arr.indexOf(s) === i)

  return {
    version: "v1",
    yearsTotal: monthsToYears(totalMonths),
    yearsPerSkill,
    skillRecency,
    titleTrajectory,
    seniorityCurrent,
    responsibilityCurrent,
    industryHistory,
    unverifiedSkills,
    computedAt: args.now ?? new Date().toISOString(),
  }
}
