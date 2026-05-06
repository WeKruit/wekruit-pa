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
