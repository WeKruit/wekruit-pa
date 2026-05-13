/**
 * @pa/job-tag-enricher — public barrel.
 *
 * Unified LLM job-tag enricher (mirror of pa-resume-parser, job-side).
 * Single shared-tags vocab. 3-tier router (gpt-5.4-nano →
 * claude-sonnet-4-6 → gpt-4.1-mini). Replaces scattered regex
 * inference at the matching layer.
 */

export {
  enrichedJobTags,
  enrichedSkillEntry,
  enrichedConfidence,
  confidenceFields,
  type EnrichedJobTags,
  type EnrichedSkillEntry,
  type EnrichedConfidence,
  type ConfidenceFields,
  type EnrichJobTagsResult,
} from "./schema.js"

export {
  ENRICHED_JOB_TAGS_JSON_SCHEMA,
  ENRICHED_JOB_TAGS_SCHEMA_NAME,
} from "./json-schema.js"

export {
  buildSystemPrompt,
  buildUserPrompt,
  SYSTEM_PROMPT,
  type JobTagPromptInput,
} from "./prompts/job-tag-prompt.js"

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
  callAnthropicMessages,
  type AnthropicCallArgs,
  type AnthropicMessagesClient,
  type AnthropicResult,
} from "./providers/anthropic-messages.js"

export {
  enrichJobTags,
  type EnrichJobTagsInput,
  type EnrichJobTagsOptions,
} from "./enricher.js"

export {
  deriveJobOpportunityDraft,
  type JobOpportunityDraft,
  type JobOpportunityDraftInput,
} from "./job-opportunity.js"
