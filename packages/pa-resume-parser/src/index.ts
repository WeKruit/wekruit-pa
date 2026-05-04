/**
 * @pa/pa-resume-parser — public barrel.
 *
 * iter30 WS1 parseResume v2: Zod schema + 3-tier retry chain (gpt-5.4-nano →
 * gpt-4.1-mini → gpt-4.1-nano), structured output, qaBank → Mem0 with
 * tag-event coupling.
 */

export {
  parsedResumeData,
  educationEntry,
  workHistoryEntry,
  projectEntry,
  awardEntry,
  volunteerEntry,
  inferredAnswer,
  degreeType,
  experienceType,
  inferredAnswerCategory,
  type ParsedResumeData,
  type EducationEntry,
  type WorkHistoryEntry,
  type ProjectEntry,
  type AwardEntry,
  type VolunteerEntry,
  type InferredAnswer,
  type DegreeType,
  type ExperienceType,
  type InferredAnswerCategory,
} from "./schema.js"

export {
  PARSED_RESUME_JSON_SCHEMA,
  PARSED_RESUME_SCHEMA_NAME,
} from "./json-schema.js"

export {
  SYSTEM_PROMPT,
  buildSystemPrompt,
  buildUserPrompt,
  type LangHint,
} from "./prompt.js"

export {
  withOuterRetry,
  isRetryable,
  NonRetryableError,
  DEFAULT_OUTER_RETRY_OPTS,
  type Logger,
  type WithOuterRetryOpts,
} from "./retry.js"

export {
  callWithFallback,
  TIER_CHAIN,
  type Tier,
  type ModelConfig,
  type RouterCallArgs,
  type RouterCallResult,
} from "./router.js"

export {
  callOpenAIResponses,
  type OpenAIResponsesArgs,
  type OpenAIResponsesClient,
  type OpenAIResponsesResult,
} from "./providers/openai-responses.js"

export {
  parseResumeText,
  type ParseResumeArgs,
  type ParseResumeResult,
} from "./parser.js"

export {
  mapQuestionToIntentTag,
  memDedupeHash,
  writeQaBankToMem0,
  type IntentTag,
  type Mem0AddArgsForQa,
  type Mem0AddAdapter,
  type Mem0SearchAdapter,
  type TagEventAdapter,
  type WriteQaBankToMem0Args,
  type WriteQaBankResult,
} from "./qabank-to-mem0.js"
