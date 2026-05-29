/**
 * Phase 52 — Canonical `careerStage` vocab. [TAG-06]
 *
 * 13 spelled-out values for hard-seniority filtering.
 * Hard filter window (e.g., `entry_level` user matches `entry_level` + `junior`
 * jobs).
 *
 * Adam-locked: D5 — no abbreviations.
 */

import { z } from "zod"

export const CAREER_STAGE_VOCAB = [
  "student",
  "intern",
  "entry_level",
  "junior",
  "mid_level",
  "senior",
  "staff",
  "principal",
  "manager",
  "director",
  "vp",
  "c_level",
  "founder",
] as const

export type CareerStage = (typeof CAREER_STAGE_VOCAB)[number]

export const CareerStageSchema = z.enum(CAREER_STAGE_VOCAB)

/**
 * Adjacency map for hard-filter window logic.
 * `acceptableSeniorityLevels(userStage)` returns the user-level + adjacent
 * one tier up/down so `entry_level` user matches `entry_level` and `junior`
 * jobs (and a `junior` user matches `entry_level` + `junior` + `mid_level`).
 *
 * `vp` and `c_level` are explicitly compatible (executive band).
 */
export const CAREER_STAGE_INDEX: Record<CareerStage, number> = {
  student: 0,
  intern: 1,
  entry_level: 2,
  junior: 3,
  mid_level: 4,
  senior: 5,
  staff: 6,
  principal: 7,
  manager: 5, // people-manager parallel band — between senior & staff
  director: 7,
  vp: 8,
  c_level: 9,
  founder: 9,
}

export function acceptableCareerStages(stage: CareerStage): CareerStage[] {
  const stages = CAREER_STAGE_VOCAB
  const userIdx = CAREER_STAGE_INDEX[stage]
  return stages.filter((s) => Math.abs(CAREER_STAGE_INDEX[s] - userIdx) <= 1)
}

/**
 * Recall fix (2026-05-29) — early-career relax window: the standard ±1
 * `acceptableCareerStages` window plus ONE tier DOWN so legit early-career
 * roles tagged `intern` (e.g. a `junior`-tagged candidate whose matching
 * corpus skews intern/new-grad) are not zeroed out. Only widens DOWNWARD —
 * the upper bound is left at the default `acceptableCareerStages` ceiling so a
 * junior candidate is never leaked director/VP/C-level roles.
 *
 * For `student`/`intern`/`entry_level`/`junior` this folds `intern` (and
 * `student` when already adjacent) into the acceptable set. For any other
 * stage it returns the default window unchanged (no upward leakage).
 */
export function earlyCareerRelaxWindow(stage: CareerStage): CareerStage[] {
  const base = new Set<CareerStage>(acceptableCareerStages(stage))
  const userIdx = CAREER_STAGE_INDEX[stage]
  for (const s of CAREER_STAGE_VOCAB) {
    const idx = CAREER_STAGE_INDEX[s]
    // widen DOWN only: include stages up to TWO tiers below the user, never
    // above the default ceiling (userIdx + 1).
    if (idx <= userIdx + 1 && idx >= userIdx - 2) base.add(s)
  }
  return [...base]
}
