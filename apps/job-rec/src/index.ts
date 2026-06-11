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
  MatchScoreSchema,
  ScoreBreakdownSchema,
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
  MatchScore,
  ScoreBreakdown,
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

// Phase 68 (HYGIENE-01) — `queryMatchingJobs` (legacy fragmented-source
// pipeline) and `createQueryMatchingJobsTool` deleted. All callers now
// use `queryMatchingJobsV16` (single source per CLAUDE.md D8). The
// helpers below remain because they're still consumed by daily-batch,
// reverse-match, tag-cluster-rec, and the V16 pipeline itself.
export {
  projectMatchingJobRow,
  rankJobs,
  scoreJob,
  jaccardOverlap,
} from "./tools/query-matching-jobs.js"
export type {
  QueryMatchingJobsDeps,
  QueryMatchingJobsArgs,
} from "./tools/query-matching-jobs.js"

// v1.6 Phase 56 — single-source canonical match cascade.
// Phase 68 (HYGIENE-01) — sole runtime entry point post-legacy deletion.
export {
  queryMatchingJobsV16,
  createQueryMatchingJobsV16Tool,
  loadUserTags,
  loadJdRelCache,
  loadLlmRerankCache,
  applyV16HardFilters,
  computeWeightedSkillJaccard,
  computeOverlap,
  cosineSim,
  computeSalaryFit,
  scoreV16Job,
  composeReason,
} from "./tools/query-matching-jobs-v16.js"
export type {
  QueryMatchingJobsV16Args,
  QueryMatchingJobsV16Deps,
  QueryMatchingJobsV16ToolDeps,
  QueryMatchingJobsV16ToolInput,
} from "./tools/query-matching-jobs-v16.js"
export {
  V16_SCORE_WEIGHTS,
  V16_SCORE_WEIGHTS_SUM,
} from "./match-weights.js"

export { buildRichMatchReason, humanizeToken } from "./match-reason.js"
export type {
  BuildRichMatchReasonInput,
  ReasonCandidate,
  ReasonJob,
  ReasonMatchedSkill,
  ReasonScoreBreakdown,
} from "./match-reason.js"
export type {
  V16ScoreBreakdown,
  V16HardFilterCounters,
  V16QueryResult,
  MatchedSkillContribution,
} from "./types.js"

export {
  candidateMatchToMarketplaceMatch,
  rankCandidatesForJob,
  scoreCandidateForJob,
} from "./two-way-match.js"
export type {
  CandidateForJobMatchResult,
  MatchScoreComponent,
  MatchingCandidateRow,
  MatchingCandidateTags,
  RecommendedMatchAction,
  S5HardFilterResult,
  ScoreCandidateForJobOptions,
} from "./two-way-match.js"

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
  USER_JOB_RECOMMENDATIONS_COLLECTION,
  loadRecommendedJobStates,
  recordRecommendedJobs,
  excludeRecentlyRecommendedJobs,
  RECENT_RECOMMENDATION_EXCLUSION_MS,
} from "./recommendation-state.js"
export type {
  RecordRecommendedJobsArgs,
  UserJobRecommendationState,
} from "./recommendation-state.js"

// 2026-06-10 trust audit — deterministic apply-URL plausibility gate, shared by
// find_match (apps/functions) and the daily batch path here. A job failing it
// delivers WITHOUT the url line + logs `rec_url_dropped`.
export { isPlausibleAtsUrl } from "./rec-url-guard.js"

// 2026-06-10 trust audit — "prescreen owns the thread": proactive/generic
// senders check the user's open prescreen work session before sending.
export {
  hasOpenPrescreenWorkSession,
  userHasOpenPrescreen,
  OPEN_PRESCREEN_WINDOW_MS,
} from "./prescreen-guard.js"

// 2026-06-11 (Adam: "every 2-3 days we should send some job matching to
// users") — cadence-audience widener. Pre-pass that auto-provisions minimal
// active pa-job-profiles rows for matched-ready users missing one. Wired in
// apps/functions/src/job-rec-daily.ts before runDailyJobRecBatch.
export {
  provisionCadenceAudience,
  AUDIENCE_PROVISION_SOURCE,
  DEFAULT_PROVISION_CAP_PER_RUN,
} from "./audience-provision.js"
export type {
  ProvisionAudienceDeps,
  ProvisionAudienceOutcome,
} from "./audience-provision.js"

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
  // Send cadence + time-spread (2026-06-02)
  ScheduleSendFn,
  FromNumberResolver,
  // Stream H13
  DailyPushContext,
} from "./daily-batch.js"

// Send cadence + time-spread planner (2026-06-02, Adam). Pure config +
// due-gate + jitter/pacing primitives — re-exported so the CF wiring + tests
// can resolve flags and plan schedules without reaching into the module.
export {
  REC_CADENCE_DAYS_FLAG_KEY,
  REC_SEND_SPREAD_WINDOW_MINUTES_FLAG_KEY,
  DEFAULT_REC_CADENCE_DAYS,
  DEFAULT_REC_SEND_SPREAD_WINDOW_MINUTES,
  resolveRecCadenceDays,
  resolveSendSpreadWindowMinutes,
  isRecSendDue,
  planSendSchedule,
  hashStringToUint as recHashStringToUint,
} from "./send-cadence.js"
export type {
  SchedulableUser,
  NumberCapacity,
  PlanSendScheduleInput,
  ScheduledSend,
  PlanSendScheduleResult,
} from "./send-cadence.js"

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

// Phase 51 (v1.5 / Stream-G.2) — TS-native tag cluster cache. Cluster
// docs live in `pa-rec-tag-clusters/{clusterId}`; default-OFF flag
// `paTagClusterRecEnabled` ramps 1% → 100%. Read RESEARCH.md §0 for the
// honest premise calibration (real win = compute reuse + determinism +
// LLM-summary cache; ~28% read reduction, NOT 10x).
export {
  computeClusterId,
  clusterKeysForUser,
  rebuildClusters,
  fetchTopKFromCluster,
  TagClusterDocSchema,
  PA_TAG_CLUSTER_REC_FLAG_KEY,
  TAG_CLUSTERS_COLLECTION,
  DEFAULT_TOP_K_PER_CLUSTER,
} from "./tag-cluster-rec.js"
export type {
  TagClusterDoc,
  RebuildClustersDeps,
  RebuildClustersOutcome,
  FetchTopKFromClusterDeps,
  UserTags,
} from "./tag-cluster-rec.js"
