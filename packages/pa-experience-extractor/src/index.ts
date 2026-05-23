/**
 * @pa/pa-experience-extractor — public barrel.
 *
 * Phase EX1 PR-A: derive per-skill experience model from existing
 * pa-users workHistory via gpt-5.4-nano. See AGENT_PLAN-experience-extractor.md.
 *
 * Backward compatibility (plan §4): nothing exported here writes to
 * existing pa-users fields. The migration script (PR-B) and the
 * resume-upload hook (PR-C) consume this package to populate two NEW
 * optional fields: `pa-users/{uid}.derivedExperience` and
 * `pa-users/{uid}.derivedExperienceVersion`.
 */

export type {
  WorkEntryExtractionInput,
  WorkEntryExtractionOutput,
  DerivedExperienceModel,
} from "./types.js"

export {
  workEntryExtractionOutput,
  llmExtractionPayload,
  LLM_JSON_SCHEMA,
  LLM_SCHEMA_NAME,
  type WorkEntryExtractionOutputParsed,
  type LlmExtractionPayload,
} from "./schema.js"

export {
  SYSTEM_PROMPT,
  buildUserPrompt,
} from "./prompt.js"

export {
  durationMonths,
  parseLooseDate,
} from "./duration.js"

export {
  computeEntryId,
} from "./entry-id.js"

export {
  inferSeniorityFromTitle,
} from "./seniority.js"

export {
  deriveExperienceModel,
  type DeriveEntryInput,
  type DeriveExperienceArgs,
} from "./derive.js"

export {
  extractWorkEntrySkills,
  DEFAULT_MODEL,
  type ExtractWorkEntryArgs,
  type ExtractWorkEntryResult,
} from "./extract.js"

export {
  firestoreExtractionCache,
  inMemoryExtractionCache,
  workEntryDocPath,
  USERS_COLLECTION,
  WORK_ENTRIES_SUBCOLLECTION,
  type ExtractionCache,
} from "./cache.js"
