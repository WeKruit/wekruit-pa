/**
 * Phase EX1 PR-A — zod runtime schemas + OpenAI json_schema payload.
 *
 * The OpenAI Responses API enforces structured output via a JSON Schema
 * passed in `text.format`. We hand-write that schema (rather than auto-
 * deriving it from zod) because OpenAI rejects some constructs zod
 * emits, notably unbounded `additionalProperties`. Hand-writing also
 * lets us pin `strict: true` semantics without surprise.
 */

import { z } from "zod"

/**
 * Runtime guard for {@link WorkEntryExtractionOutput}.
 *
 * Used to parse the LLM's raw JSON output. A parse failure throws
 * `NonRetryableError` upstream so we don't waste retries on a bad model
 * response (the model rarely recovers from a structured-output miss).
 */
export const workEntryExtractionOutput = z.object({
  entryId: z.string().min(1),
  extractedSkills: z.array(z.string().min(1)).max(40),
  durationMonths: z.number().min(0).max(1200),
  industryGuess: z.string().nullable(),
  responsibilityLevel: z.enum([
    "individual_contributor",
    "tech_lead",
    "people_manager",
    "executive",
    "unknown",
  ]),
  confidence: z.number().min(0).max(1),
  llmModel: z.string().min(1),
  extractedAt: z.string().min(1),
})

export type WorkEntryExtractionOutputParsed = z.infer<
  typeof workEntryExtractionOutput
>

/**
 * Subset of {@link WorkEntryExtractionOutput} the LLM is responsible
 * for producing. The non-model fields (`entryId`, `durationMonths`,
 * `llmModel`, `extractedAt`) are filled by {@link extractWorkEntrySkills}
 * after the call returns — they are deterministic from input + clock.
 */
export const llmExtractionPayload = z.object({
  extractedSkills: z.array(z.string().min(1)).max(40),
  industryGuess: z.string().nullable(),
  responsibilityLevel: z.enum([
    "individual_contributor",
    "tech_lead",
    "people_manager",
    "executive",
    "unknown",
  ]),
  confidence: z.number().min(0).max(1),
})
export type LlmExtractionPayload = z.infer<typeof llmExtractionPayload>

/**
 * Name passed in the OpenAI structured-output request. Stable so the
 * OpenAI usage dashboard groups all our calls together.
 */
export const LLM_SCHEMA_NAME = "work_entry_skill_extraction"

/**
 * Strict JSON Schema for the OpenAI Responses API. Mirrors
 * {@link llmExtractionPayload}. Hand-rolled because zod-to-json-schema
 * emits constructs (e.g. `$schema`, recursive `definitions`) that
 * OpenAI's `strict: true` mode rejects.
 */
export const LLM_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    extractedSkills: {
      type: "array",
      maxItems: 40,
      items: { type: "string", minLength: 1 },
    },
    industryGuess: { type: ["string", "null"] },
    responsibilityLevel: {
      type: "string",
      enum: [
        "individual_contributor",
        "tech_lead",
        "people_manager",
        "executive",
        "unknown",
      ],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "extractedSkills",
    "industryGuess",
    "responsibilityLevel",
    "confidence",
  ],
}
