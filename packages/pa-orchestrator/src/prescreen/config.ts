/**
 * v1.8 Phase 78 — PrescreenConfig schema + loader.
 *
 * The single source of truth for what a `pa-jobs/{jobId}.prescreenConfig`
 * looks like. Consumed by:
 *   1. Employer-side dashboard editor (Phase 78 React page) — drives form
 *      shape + validation
 *   2. Pre-screen pipeline bootstrap (when a candidate trigger fires) —
 *      builds `PreScreenQuestion[]` from `Question[]` + thresholds
 *
 * Per PS1+PS2+PS3, Questions reuse the same `Question` abstraction as
 * onboarding. The config maps 1-to-1 to the constructor args of
 * `KeywordSetJudge` + `PreScreenPipeline`.
 *
 * Zod-validated at the storage boundary (employer save + pipeline load) so
 * malformed configs never reach runtime.
 */

import { z } from "zod"
import type { QuestionType } from "../onboarding/question.js"

// ────────────────────────────────────────────────────────────────────────────
// Zod schemas
// ────────────────────────────────────────────────────────────────────────────

export const KeywordSpecSchema = z.object({
  keyword: z.string().min(1).max(60),
  weight: z.number().min(0.1).max(10).optional(),
  hint: z.string().max(200).optional(),
})

export const QuestionTypeSchema = z.enum(["MUST_HAVE", "PROBING", "GOOD_TO_HAVE"])

export const BilingualTextSchema = z.object({
  zh: z.string().min(1).max(800),
  en: z.string().min(1).max(800),
})

/**
 * One pre-screen question as authored in the dashboard.
 *
 * `qId` MUST be unique within a prescreenConfig; the pipeline uses it as
 * the key into `PreScreenState.questions`.
 */
export const PrescreenQuestionConfigSchema = z.object({
  qId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "qId must be lowercase + alphanumeric + underscore"),
  type: QuestionTypeSchema,
  weight: z.number().min(0.1).max(10).default(1.0),
  /**
   * v1.9 hotfix — per-Q τ_m match threshold override. Defaults to type's
   * baseline:
   *   MUST_HAVE → 1.0 (any mismatch fails — PS2 lock)
   *   PROBING   → 0.7
   *   GOOD_TO_HAVE → 0 (never blocks)
   *
   * Real-LLM scoring (gpt-5.4-nano) rarely hits 1.0 even on strong answers.
   * Recommended override for production MUST_HAVE Qs: 0.85.
   */
  matchThreshold: z.number().min(0).max(1).optional(),
  prompt: BilingualTextSchema,
  clarifyPrompt: BilingualTextSchema,
  keywords: z.array(KeywordSpecSchema).min(1).max(20),
})

/**
 * Full prescreenConfig as stored in Firestore at
 * `pa-jobs/{jobId}.prescreenConfig`.
 *
 * Thresholds carry per-job overrides for τ_m / τ_c / T and max clarify
 * rounds. Defaults match v1.8 spec.
 */
export const PrescreenConfigSchema = z
  .object({
    /** Version stamp — bump when schema changes incompatibly. */
    version: z.literal(1).default(1),
    /** Display name shown in the candidate's opening message. */
    jobTitle: z.string().min(1).max(120),
    /** Optional company name, also shown to candidate. */
    company: z.string().max(120).optional(),
    /** Pass threshold T ∈ [0,1]. */
    threshold: z.number().min(0.3).max(1.0).default(0.65),
    /** Confidence threshold τ_c ∈ [0,1]. */
    confidenceThreshold: z.number().min(0.3).max(1.0).default(0.7),
    /** Max clarification rounds per Q (PS6 default 2). */
    maxClarifyRounds: z.number().int().min(0).max(5).default(2),
    /** Voice mode — onboarding default vs pre-screen professional. */
    voiceMode: z
      .enum(["casual_onboarding", "professional_prescreen"])
      .default("professional_prescreen"),
    /**
     * Questions in PRIORITY ORDER. The pipeline asks them in this order,
     * so authors should put MUST_HAVE first (fail-fast), then PROBING, then
     * GOOD_TO_HAVE. Validator does NOT auto-reorder — it would obscure
     * author intent + complicate diff reviews.
     */
    questions: z.array(PrescreenQuestionConfigSchema).min(1).max(20),
    /**
     * v1.9 Phase 84 — Level 1 reveal fields, surfaced ONLY on PASS terminal.
     * If omitted, the Level 1 follow-up SMS falls back to a generic CTA.
     */
    level1Reveal: z
      .object({
        applyUrl: z.string().url().max(2000).optional(),
        salaryRange: z.string().max(80).optional(),
        nextStepEta: z.string().max(80).optional(),
      })
      .optional(),
    /** Optional last-edited metadata stamped at save time. */
    lastEditedBy: z.string().max(120).optional(),
    lastEditedAt: z.string().datetime().optional(),
  })
  .superRefine((cfg, ctx) => {
    // Uniqueness check for qIds.
    const seen = new Set<string>()
    for (const q of cfg.questions) {
      if (seen.has(q.qId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions"],
          message: `duplicate qId: ${q.qId}`,
        })
      }
      seen.add(q.qId)
    }
    // Total weight must be > 0.
    const totalWeight = cfg.questions.reduce((s, q) => s + q.weight, 0)
    if (totalWeight <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions"],
        message: "total weight must be > 0",
      })
    }
  })

// ────────────────────────────────────────────────────────────────────────────
// Inferred types
// ────────────────────────────────────────────────────────────────────────────

export type PrescreenConfig = z.infer<typeof PrescreenConfigSchema>
export type PrescreenQuestionConfig = z.infer<typeof PrescreenQuestionConfigSchema>
export type KeywordSpecConfig = z.infer<typeof KeywordSpecSchema>

// ────────────────────────────────────────────────────────────────────────────
// Loader / validator entry points
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strict parse — throws ZodError on any issue. Use at the storage boundary
 * (employer save) where invalid configs MUST be rejected.
 */
export function parsePrescreenConfig(raw: unknown): PrescreenConfig {
  return PrescreenConfigSchema.parse(raw)
}

/**
 * Safe parse — returns success/error envelope. Use at the pipeline load
 * site so we degrade gracefully (skip pre-screen for this job + alert)
 * when a corrupt config slips past the editor.
 */
export function safeParsePrescreenConfig(
  raw: unknown
): { ok: true; config: PrescreenConfig } | { ok: false; error: z.ZodError } {
  const r = PrescreenConfigSchema.safeParse(raw)
  if (r.success) return { ok: true, config: r.data }
  return { ok: false, error: r.error }
}

// ────────────────────────────────────────────────────────────────────────────
// Pipeline mapping helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract the question-meta tuple list consumed by
 * `emptyPreScreenState({questions})`. Pipeline state has no concept of the
 * keyword set itself — that lives in the per-Q `PreScreenQuestion`
 * binding (the KeywordSetJudge constructor consumes it directly).
 */
export function configToStateQuestions(
  cfg: PrescreenConfig
): Array<{ qId: string; type: QuestionType; weight: number; matchThreshold?: number }> {
  return cfg.questions.map((q) => ({
    qId: q.qId,
    type: q.type,
    weight: q.weight,
    ...(q.matchThreshold !== undefined ? { matchThreshold: q.matchThreshold } : {}),
  }))
}

/**
 * Compute the max achievable score (S_max) for a config. Used by the
 * dashboard preview ("This config requires ≥65% of 7 weighted points") +
 * by the pipeline at session init.
 */
export function configMaxScore(cfg: PrescreenConfig): number {
  return cfg.questions.reduce((s, q) => s + q.weight, 0)
}

/**
 * Compute the required score for a PASS — convenience for dashboard display.
 */
export function configRequiredScore(cfg: PrescreenConfig): number {
  return configMaxScore(cfg) * cfg.threshold
}
