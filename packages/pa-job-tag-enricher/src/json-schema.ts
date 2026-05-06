/**
 * @pa/job-tag-enricher — Pre-baked OpenAI Responses API JSON Schema for
 * `enrichedJobTags`.
 *
 * Mirrors `schema.ts` (Zod) in JSON Schema form for `text.format = { type:
 * "json_schema", strict: true }` calls. OpenAI strict mode requires every
 * property to appear in `required` (even nullable ones) and
 * `additionalProperties: false` everywhere.
 *
 * Vocab arrays are imported from shared-tags — single source of truth.
 * A parity test (`__tests__/schema-parity.test.ts`) ensures the field set
 * stays in lockstep with `schema.ts`.
 */

import {
  ROLE_FUNCTION_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  CAREER_STAGE_VOCAB,
  JOB_TYPE_VOCAB,
  LOCATION_VOCAB,
  SKILL_BUCKET_VOCAB,
  SKILL_PROFICIENCY_VOCAB,
} from "@wekruit/shared-tags/canonical"

const skillItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "bucket", "proficiency", "evidenceCount", "baseWeight"],
  properties: {
    name: { type: "string" },
    bucket: { type: "string", enum: [...SKILL_BUCKET_VOCAB] },
    proficiency: { type: "string", enum: [...SKILL_PROFICIENCY_VOCAB] },
    evidenceCount: { type: "integer", minimum: 0 },
    baseWeight: { type: "number", minimum: 0, maximum: 1 },
  },
} as const

const confidenceFieldsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "roleFunction",
    "industrySector",
    "relevantTags",
    "skills",
    "seniorityLevel",
    "locationBuckets",
    "jobType",
  ],
  properties: {
    roleFunction: { type: "number", minimum: 0, maximum: 1 },
    industrySector: { type: "number", minimum: 0, maximum: 1 },
    relevantTags: { type: "number", minimum: 0, maximum: 1 },
    skills: { type: "number", minimum: 0, maximum: 1 },
    seniorityLevel: { type: "number", minimum: 0, maximum: 1 },
    locationBuckets: { type: "number", minimum: 0, maximum: 1 },
    jobType: { type: "number", minimum: 0, maximum: 1 },
  },
} as const

export const ENRICHED_JOB_TAGS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "roleFunction",
    "industrySector",
    "relevantTags",
    "skills",
    "seniorityLevel",
    "sponsorshipHint",
    "locationBuckets",
    "jobType",
    "confidence",
  ],
  properties: {
    roleFunction: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: { type: "string", enum: [...ROLE_FUNCTION_VOCAB] },
    },
    industrySector: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string", enum: [...INDUSTRY_SECTOR_VOCAB] },
    },
    relevantTags: {
      type: "array",
      maxItems: 12,
      items: { type: "string" },
    },
    skills: {
      type: "array",
      maxItems: 40,
      items: skillItemSchema,
    },
    seniorityLevel: { type: "string", enum: [...CAREER_STAGE_VOCAB] },
    sponsorshipHint: { type: ["boolean", "null"] },
    locationBuckets: {
      type: "array",
      maxItems: 6,
      items: { type: "string", enum: [...LOCATION_VOCAB] },
    },
    jobType: { type: "string", enum: [...JOB_TYPE_VOCAB] },
    confidence: {
      type: "object",
      additionalProperties: false,
      required: ["overall", "fields"],
      properties: {
        overall: { type: "number", minimum: 0, maximum: 1 },
        fields: confidenceFieldsSchema,
      },
    },
  },
} as const

export const ENRICHED_JOB_TAGS_SCHEMA_NAME = "enriched_job_tags"
