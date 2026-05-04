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
})
export type ParsedResumeData = z.infer<typeof parsedResumeData>
