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
} from "./daily-batch.js"
export type { DailyBatchDeps, BatchOutcome, FlagChecker } from "./daily-batch.js"
