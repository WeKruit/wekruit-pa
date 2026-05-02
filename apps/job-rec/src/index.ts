/**
 * @pa/job-rec — public surface.
 *
 * Stream B greenfield: RecruiterAgent + 4 tools + daily batch driver.
 * Cloud Functions live in apps/functions; this package owns the pure
 * logic so the CF bundle can import + invoke us.
 */

export {
  ResumeProfileSchema,
  JobProfileSchema,
  JobProfileDocSchema,
  JobIndustrySchema,
  JobSponsorshipNeedSchema,
  JobSizePreferenceSchema,
  MatchingJobSchema,
  ParseResumeInputSchema,
  ParseResumeOutputSchema,
  QueryMatchingJobsInputSchema,
  QueryMatchingJobsOutputSchema,
  QueryMatchingJobsFiltersSchema,
  SaveJobProfileInputSchema,
  SaveJobProfileOutputSchema,
  SendImessageInputSchema,
  SendImessageOutputSchema,
  JOB_PROFILES_COLLECTION,
  JOB_REC_FLAG_KEY,
} from "./types.js"
export type {
  ResumeProfile,
  JobProfile,
  JobProfileDoc,
  JobIndustry,
  JobSponsorshipNeed,
  JobSizePreference,
  MatchingJob,
  ParseResumeInput,
  ParseResumeOutput,
  QueryMatchingJobsInput,
  QueryMatchingJobsOutput,
  QueryMatchingJobsFilters,
  SaveJobProfileInput,
  SaveJobProfileOutput,
  SendImessageInput,
  SendImessageOutput,
} from "./types.js"

export {
  parseResume,
  createParseResumeTool,
  projectParsedDocToResumeProfile,
} from "./tools/parse-resume.js"
export type { ParseResumeDeps, ParseResumeArgs } from "./tools/parse-resume.js"

export {
  queryMatchingJobs,
  createQueryMatchingJobsTool,
  projectMatchingJobRow,
  rankJobs,
  scoreJob,
  jaccardOverlap,
} from "./tools/query-matching-jobs.js"
export type {
  QueryMatchingJobsDeps,
  QueryMatchingJobsArgs,
} from "./tools/query-matching-jobs.js"

export {
  saveJobProfile,
  createSaveJobProfileTool,
} from "./tools/save-job-profile.js"
export type { SaveJobProfileDeps, SaveJobProfileArgs } from "./tools/save-job-profile.js"

export {
  sendImessage,
  createSendImessageTool,
} from "./tools/send-imessage.js"
export type { SendImessageDeps, SendImessageArgs } from "./tools/send-imessage.js"

export {
  buildRecruiterAgent,
  buildRecruiterSystemPrompt,
  runRecruiterTurn,
  ONBOARDING_ADDENDUM,
} from "./recruiter-agent.js"
export type {
  RecruiterAgentDeps,
  RunRecruiterTurnArgs,
  RunRecruiterTurnResult,
} from "./recruiter-agent.js"

export {
  runDailyJobRecBatch,
  formatBatchMessage,
  formatJobLine,
  defaultUserEmbedFetcher,
  rerankByCosine,
  cosineSimilarity,
  normalizeJobProfile,
  // Stream H13 — friend-tone CV-aware opener
  formatDailyPushBody,
  formatJobLineWithReason,
  buildJobReason,
  loadDailyPushContext,
  FRIEND_TONE_OPENER_FLAG_KEY,
} from "./daily-batch.js"
export type {
  DailyBatchDeps,
  BatchOutcome,
  FlagChecker,
  UserEmbedFetcher,
  UserEmbedComputer,
  CrossEncoderReranker,
  // Stream H13
  DailyPushContext,
} from "./daily-batch.js"

export {
  rerankWithCrossEncoder,
  buildRerankQuery,
  buildJobCandidateText,
} from "./cross-encoder-rerank.js"
export type {
  RerankCandidate,
  RerankerDeps,
  RerankedItem,
} from "./cross-encoder-rerank.js"

// Stream F (Phase 42) — async cheap-LLM match-explainer (closes TD-H13-1).
export {
  explainMatch,
  buildExplainerMessages,
  sanitizeReason,
  computeChargeUsd,
  resolveDailyBudgetUsd,
  cacheDocId,
  costLedgerDocId,
  defaultTodayYmd as defaultExplainerYmd,
  defaultChatImpl,
  MATCH_EXPLAINER_FLAG_KEY,
  EXPLANATIONS_COLLECTION,
  COST_LEDGER_COLLECTION,
  COST_LEDGER_DOC_PREFIX,
  CACHE_TTL_MS,
  DEFAULT_MODEL as MATCH_EXPLAINER_DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS as MATCH_EXPLAINER_DEFAULT_TIMEOUT_MS,
  DEFAULT_DAILY_BUDGET_USD as MATCH_EXPLAINER_DEFAULT_DAILY_BUDGET_USD,
} from "./match-explainer.js"
export type {
  ChatImpl as MatchExplainerChatImpl,
  ExplainMatchInput,
  ExplainMatchDeps,
  ExplainerCv,
} from "./match-explainer.js"

// Phase 43 (v1.5 / Stream-C) — hard-filter primitives. Newly exported in
// Phase 49 so the reverse-match dashboard CF can reuse the same logic on
// the (profile, [synthJob]) pair. Forward path still imports directly via
// daily-batch.ts; this re-export is purely additive.
export {
  applyHardFilters,
  applyHardFiltersWithFallback,
} from "./tools/query-matching-jobs.js"
export type {
  HardFilterUserProfile,
  HardFilterResult,
} from "./tools/query-matching-jobs.js"

// Phase 49 (v1.5 / Stream-H / D9) — reverse-match domain logic. Pure;
// CF wrapper lives in apps/functions/src/paReverseMatch.ts.
export {
  runReverseMatch,
  synthesizeJobFromJd,
  buildUserCandidateText,
  buildMatchedReasons,
  buildNotifyMessage,
  passesReverseHardFilter,
  REVERSE_MATCH_FLAG_KEY,
  REVERSE_MATCH_POOL_CAP,
  REVERSE_MATCH_COSINE_TOP_N,
  REVERSE_MATCH_DEFAULT_TOP_K,
  REVERSE_MATCH_DAILY_CAP_PER_JD,
  REVERSE_MATCH_BULK_NOTIFY_CAP,
} from "./reverse-match.js"
export type {
  ReverseMatchInput,
  ReverseMatchOutput,
  ReverseMatchCandidate,
  ReverseMatchUserProfile,
  ReverseMatchDeps,
} from "./reverse-match.js"
