/**
 * Phase 52 — Canonical `jobType` vocab. [TAG-05]
 *
 * 10 spelled-out values. Hard filter exact match.
 *
 * Adam-locked: D5 — no abbreviations (use `full_time` not `ft`).
 */

import { z } from "zod"

export const JOB_TYPE_VOCAB = [
  "full_time",
  "internship",
  "new_graduate",
  "contract",
  "part_time",
  "fellowship",
  "apprenticeship",
  "freelance",
  "return_to_work_program",
  "co_op_rotation",
] as const

export type JobType = (typeof JOB_TYPE_VOCAB)[number]

export const JobTypeSchema = z.enum(JOB_TYPE_VOCAB)

export const JobTypeListSchema = z.array(JobTypeSchema)
