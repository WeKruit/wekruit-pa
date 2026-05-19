import { z } from "zod"

export const PracticeQuestionStatusSchema = z.enum(["active", "draft", "archived"])
export type PracticeQuestionStatus = z.infer<typeof PracticeQuestionStatusSchema>

export const PracticeQuestionKindSchema = z.enum([
  "system_design",
  "object_oriented_design",
  "data_case",
  "behavioral",
])
export type PracticeQuestionKind = z.infer<typeof PracticeQuestionKindSchema>

export const PracticeConversationModeSchema = z.enum([
  "system_design_discussion",
  "object_design_discussion",
  "data_case_discussion",
  "behavioral_screen",
  "resume_deep_dive",
])
export type PracticeConversationMode = z.infer<typeof PracticeConversationModeSchema>

export const PracticeQuestionDifficultySchema = z.enum(["easy", "medium", "hard"])
export type PracticeQuestionDifficulty = z.infer<typeof PracticeQuestionDifficultySchema>

export const PracticeRubricItemSchema = z.object({
  criterion: z.string().min(1).max(200),
  weight: z.number().min(0).max(10).optional(),
  guidance: z.string().max(3000).optional(),
})
export type PracticeRubricItem = z.infer<typeof PracticeRubricItemSchema>

export const PracticeEvaluationSchema = z.object({
  rubric: z.array(PracticeRubricItemSchema).default([]),
  followUps: z.array(z.string().min(1).max(1200)).default([]),
  expectedSignals: z.array(z.string().min(1).max(1200)).default([]),
  redFlags: z.array(z.string().min(1).max(1200)).default([]),
  interviewerGuide: z.string().max(12000).optional(),
  solutionSummary: z.string().max(20000).optional(),
})
export type PracticeEvaluation = z.infer<typeof PracticeEvaluationSchema>

export const PracticeQuestionBankItemSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(160),
  status: PracticeQuestionStatusSchema,
  kind: PracticeQuestionKindSchema,
  conversationMode: PracticeConversationModeSchema,
  title: z.string().min(1).max(280),
  prompt: z.string().min(1).max(12000),
  context: z.string().max(30000).optional(),
  difficulty: PracticeQuestionDifficultySchema.optional(),
  estimatedMinutes: z.number().int().min(1).max(240).optional(),
  companyStyle: z.array(z.string().min(1).max(120)).default([]),
  roleFamilies: z.array(z.string().min(1).max(120)).default([]),
  categories: z.array(z.string().min(1).max(120)).default([]),
  tags: z.array(z.string().min(1).max(120)).default([]),
  keyConcepts: z.array(z.string().min(1).max(160)).default([]),
  evaluation: PracticeEvaluationSchema,
  sourceRefs: z.array(z.string().min(1).max(1000)).default([]),
  contentFingerprint: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.string().min(1).max(160),
  updatedBy: z.string().min(1).max(160),
})
export type PracticeQuestionBankItem = z.infer<typeof PracticeQuestionBankItemSchema>

