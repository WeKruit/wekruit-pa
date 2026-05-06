/**
 * iter30 WS1 — parseResume v2 Zod schema.
 *
 * Ported from VALET `packages/shared/src/schemas/resume.schema.ts` with
 * snake_case → camelCase normalization (Adam-locked).
 *
 * 19 top-level fields. `inferredAnswers` is the qaBank source for
 * downstream Mem0 + tag-event coupling.
 */
import { z } from "zod"

export const degreeType = z.enum([
  "high-school",
  "associate",
  "bachelor-of-arts",
  "bachelor-of-science",
  "master-of-arts",
  "master-of-science",
  "mba",
  "phd",
  "md",
  "jd",
  "other",
])
export type DegreeType = z.infer<typeof degreeType>

export const experienceType = z.enum([
  "full-time",
  "part-time",
  "contract",
  "internship",
  "freelance",
  "volunteer",
])
export type ExperienceType = z.infer<typeof experienceType>

export const inferredAnswerCategory = z.enum([
  "personal",
  "experience",
  "education",
  "skills",
  "preferences",
])
export type InferredAnswerCategory = z.infer<typeof inferredAnswerCategory>

export const educationEntry = z.object({
  school: z.string(),
  degree: z.string().default(""),
  degreeType: degreeType.nullable().optional(),
  fieldOfStudy: z.string().nullable().optional(),
  major: z.string().nullable().optional(),
  gpa: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  expectedGraduation: z.string().nullable().optional(),
  honors: z.string().nullable().optional(),
})
export type EducationEntry = z.infer<typeof educationEntry>

export const workHistoryEntry = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string().nullable().optional(),
  experienceType: experienceType.nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  currentRole: z.boolean().nullable().optional(),
  description: z.string().nullable().optional(),
  bullets: z.array(z.string()).default([]),
  achievements: z.array(z.string()).default([]),
})
export type WorkHistoryEntry = z.infer<typeof workHistoryEntry>

export const projectEntry = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  technologies: z.array(z.string()).default([]),
  url: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
})
export type ProjectEntry = z.infer<typeof projectEntry>

export const awardEntry = z.object({
  title: z.string(),
  issuer: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
})
export type AwardEntry = z.infer<typeof awardEntry>

export const volunteerEntry = z.object({
  organization: z.string(),
  role: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
})
export type VolunteerEntry = z.infer<typeof volunteerEntry>

export const inferredAnswer = z.object({
  question: z.string(),
  answer: z.string(),
  confidence: z.number().min(0).max(1),
  category: inferredAnswerCategory,
})
export type InferredAnswer = z.infer<typeof inferredAnswer>

/**
 * Phase 53 — `relevantTags`/`proposedTags` open-vocab pattern.
 * Lowercase + underscore, 2-80 chars, must start with a letter.
 * Mirrors `RELEVANT_TAG_PATTERN` from `@wekruit/shared-tags` (kept as a
 * literal here to avoid a runtime dep on shared-tags inside this schema).
 */
const PROPOSED_TAG_PATTERN = /^[a-z][a-z0-9_]{1,79}$/

export const parsedResumeData = z.object({
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  summary: z.string().nullable(),
  skills: z.array(z.string()).default([]),
  workHistory: z.array(workHistoryEntry).default([]),
  education: z.array(educationEntry).default([]),
  projects: z.array(projectEntry).default([]),
  certifications: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  interests: z.array(z.string()).default([]),
  awards: z.array(awardEntry).default([]),
  volunteerWork: z.array(volunteerEntry).default([]),
  websites: z.array(z.string()).default([]),
  totalYearsExperience: z.number().nullable(),
  workAuthorization: z.string().nullable(),
  parseConfidence: z.number().min(0).max(1),
  inferredAnswers: z.array(inferredAnswer).default([]),

  // ── Phase 53 (PARSE-03..PARSE-05) ─────────────────────────────────
  /**
   * Phase 53 (PARSE-03) — derived industry sectors per work-history.
   * Closed enum from `@wekruit/shared-tags/canonical/industry-sector`
   * (42 values). Validated downstream by cv-ingest; tolerated here as
   * a free-form string array so the LLM may emit candidates that get
   * filtered to canonical at write-time.
   */
  relevantIndustry: z.array(z.string()).max(6).default([]),

  /**
   * Phase 53 (PARSE-04) — sub-domain expertise tokens (e.g.
   * `frontend_development`, `mlops`, `infrastructure_security`).
   */
  relevantSpecialization: z.array(z.string()).max(6).default([]),

  /**
   * Phase 53 (PARSE-05) — sandbox open-vocab tags (max 12). Must match
   * the canonical pattern; abbreviations rejected at write-time by
   * cv-ingest's shared-tags `validateRelevantTag`.
   */
  proposedTags: z
    .array(z.string().regex(PROPOSED_TAG_PATTERN, "must match [a-z][a-z0-9_]{1,79}"))
    .max(12)
    .default([]),
})
export type ParsedResumeData = z.infer<typeof parsedResumeData>
