/**
 * v2.1 S1B — barrel re-exports for voice context loaders.
 *
 * S2 voice bridge imports from this index. Internal loader files stay split
 * so test isolation + commit atomicity is preserved.
 */

export { NotFoundError } from "./types.js"
export type {
  VoiceUserProfile,
  VoiceJobBrief,
  VoicePrescreenConfig,
  PrescreenConfig,
  PrescreenQuestionConfig,
} from "./types.js"

export { loadUserProfileForVoice } from "./load-user-profile.js"
export { loadJobBriefForVoice } from "./load-job-brief.js"
export { loadPrescreenConfigForVoice } from "./load-prescreen-config.js"
